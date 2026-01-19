import http from "http";
import { WebSocketServer } from "ws";
import { logger } from "../shared/logger.js";
import { handleMessage } from "./handlers.js";
import { createError } from "../shared/messages.js";
import { verifyToken } from "./auth.js";
import { executeCommand } from "../shared/executor.js";
import { validateHostnameConsistency } from "../modules/metadata/actions/utils.js";

const DEFAULT_HEALTHCHECK_PATH = "/healthcheck";

/**
 * Exécute une commande sur l'hôte via nsenter
 * @param {string} command - Commande à exécuter
 * @param {Object} [options] - Options d'exécution
 * @returns {Promise<Object>} Résultat de l'exécution
 */
async function executeHostCommand(command, options = {}) {
  const escapedCommand = command.replace(/'/g, "'\"'\"'");
  const nsenterCommand = `nsenter -t 1 -m -u -i -n -p -- sh -c '${escapedCommand}'`;

  return await executeCommand(nsenterCommand, {
    timeout: options.timeout || 5000,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
  });
}

/**
 * Récupère le hostname de l'hôte via nsenter
 * @returns {Promise<string|null>} Hostname ou null en cas d'erreur
 */
async function getHostname() {
  try {
    // Utiliser nsenter pour exécuter hostname sur l'hôte depuis le conteneur
    const result = await executeHostCommand("hostname", {
      timeout: 5000,
    });

    logger.debug("Résultat de getHostname", {
      stdout: result.stdout,
      stderr: result.stderr,
      hasError: result.error,
      stdoutLength: result.stdout?.length,
      stdoutTrimmed: result.stdout?.trim(),
    });

    if (result.stdout && result.stdout.trim()) {
      const hostname = result.stdout.trim();
      logger.info(`Hostname récupéré via nsenter: ${hostname}`);
      return hostname;
    }

    logger.warn("Impossible de récupérer le hostname via nsenter", {
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
    });
    return null;
  } catch (error) {
    logger.error("Erreur lors de la récupération du hostname via nsenter", {
      error: error.message,
      stack: error.stack,
    });
    return null;
  }
}

/**
 * Serveur WebSocket frontend.
 *
 * Ce module encapsule la création du serveur HTTP + WebSocket et gère :
 * - l'authentification via query string (token),
 * - l'isolation des connexions (cleanup des streams par client),
 * - la délégation des messages à `handleMessage`,
 * - l'arrêt propre (terminaison des clients, fermeture du serveur HTTP).
 *
 * @param {Object} options - Options de configuration
 * @param {number} options.port - Port d'écoute
 * @param {string} options.host - Interface réseau d'écoute
 * @returns {{ server: import('http').Server, wss: WebSocketServer, close: () => Promise<void> }}
 */
export async function createFrontendServer({
  port,
  host,
  serverIp,
  healthcheckPath = DEFAULT_HEALTHCHECK_PATH,
}) {
  // Récupérer le hostname de l'hôte via nsenter
  const hostname = await getHostname();
  if (!hostname) {
    logger.warn(
      "Impossible de récupérer le hostname, certaines vérifications seront désactivées"
    );
  } else {
    logger.info("Hostname récupéré pour les vérifications", { hostname });
  }

  const normalizedHealthcheckPath = normalizeHealthcheckPath(healthcheckPath);
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    perMessageDeflate: false,
  });

  server.on("request", (req, res) => {
    handleHttpRequest(req, res, normalizedHealthcheckPath);
  });

  /**
   * Gestionnaire de connexion WebSocket
   *
   * Ce handler est appelé à chaque tentative de connexion WebSocket.
   * Il effectue les vérifications de sécurité suivantes :
   * 1. Validation de l'URL de connexion
   * 2. Vérification du hostname (doit correspondre au hostname de l'agent)
   * 3. Vérification du token (décodage local)
   *
   * Si toutes les vérifications passent, la connexion est acceptée et
   * le client peut commencer à envoyer des messages.
   */
  wss.on("connection", async (ws, req) => {
    let connectionUrl;

    // ============================================
    // ÉTAPE 1 : Parser et valider l'URL de connexion
    // ============================================
    try {
      // Construire l'URL complète depuis l'URL relative et les headers
      connectionUrl = new URL(req.url || "/", `http://${req.headers.host}`);
    } catch (error) {
      // URL malformée : refuser la connexion immédiatement
      logger.warn("URL de connexion WebSocket invalide", {
        error: error.message,
        remoteAddress: req.socket.remoteAddress,
      });
      ws.close(1008, "Invalid connection URL");
      return;
    }

    // Extraire les paramètres de l'URL
    // Le token généré par le frontend (valide ~5 minutes)
    const clientToken = connectionUrl.searchParams.get("token");
    // Le hostname du serveur que le client veut gérer
    const requestedServerHostname =
      connectionUrl.searchParams.get("hostname") || null;

    // ============================================
    // ÉTAPE 2 : Vérifier le hostname
    // ============================================
    // Le hostname doit être présent dans l'URL ET correspondre au hostname configuré de l'agent.
    // Cela empêche un client de se connecter à un agent qui gère un autre serveur.

    // Vérifier d'abord que le hostname est présent dans l'URL
    if (
      !requestedServerHostname ||
      requestedServerHostname.trim().length === 0
    ) {
      logger.warn("Tentative de connexion sans hostname dans l'URL", {
        remoteAddress: req.socket.remoteAddress,
      });
      ws.close(1008, "Hostname requis dans l'URL");
      return;
    }

    // Normaliser les hostnames pour la comparaison (trim et lowercase)
    const normalizedRequestedHostname = requestedServerHostname
      .trim()
      .toLowerCase();
    const normalizedExpectedHostname = hostname
      ? hostname.trim().toLowerCase()
      : null;

    // Vérifier que le hostname correspond à celui de l'hôte
    if (!normalizedExpectedHostname) {
      logger.warn(
        "Hostname de l'hôte non disponible, impossible de vérifier la correspondance",
        {
          remoteAddress: req.socket.remoteAddress,
          requestedHostname: requestedServerHostname,
        }
      );
      ws.close(
        1008,
        "Configuration serveur invalide (hostname non disponible)"
      );
      return;
    }

    if (normalizedRequestedHostname !== normalizedExpectedHostname) {
      logger.warn("Tentative de connexion avec hostname incorrect", {
        remoteAddress: req.socket.remoteAddress,
        requestedHostname: requestedServerHostname,
        normalizedRequestedHostname,
        expectedHostname: hostname,
        normalizedExpectedHostname,
        match: normalizedRequestedHostname === normalizedExpectedHostname,
        comparison: `"${normalizedRequestedHostname}" !== "${normalizedExpectedHostname}"`,
      });
      ws.close(1008, "Hostname incorrect");
      return;
    }

    logger.debug("Hostname vérifié avec succès", {
      requestedHostname: requestedServerHostname,
      expectedHostname: hostname,
      normalizedRequestedHostname,
      normalizedExpectedHostname,
    });

    // ============================================
    // ÉTAPE 2.5 : Vérifier la cohérence des hostnames (reçu vs serveur)
    // ============================================
    // Vérification asynchrone en arrière-plan (non-bloquante)
    // Si la validation échoue, on ferme la connexion mais on ne bloque pas l'initialisation
    (async () => {
      try {
        const validation = validateHostnameConsistency(
          requestedServerHostname,
          hostname
        );

        if (!validation.valid) {
          logger.error("Incohérence des hostnames détectée", {
            receivedHostname: requestedServerHostname,
            serverHostname: hostname,
            error: validation.error,
          });
          // Fermer la connexion de manière asynchrone
          ws.close(1008, validation.error || "Incohérence des hostnames");
          return;
        }

        logger.debug("Cohérence des hostnames vérifiée", {
          receivedHostname: requestedServerHostname,
          serverHostname: hostname,
        });
      } catch (error) {
        logger.error(
          "Erreur lors de la vérification de cohérence des hostnames",
          {
            error: error.message,
          }
        );
        // Ne pas bloquer la connexion si la vérification échoue, mais logger l'erreur
      }
    })();

    // ============================================
    // ÉTAPE 3 : Vérifier le token localement
    // ============================================
    if (clientToken) {
      // Un token est fourni : le vérifier localement sans appel API
      // Cette vérification décode le token et vérifie :
      // - Expiration du token (pas expiré, valide 5 minutes)
      // - Correspondance du hostname avec celui de l'agent
      // - Correspondance de l'IP avec celle du serveur
      if (!serverIp) {
        logger.error(
          "IP du serveur non disponible, impossible de vérifier le token",
          {
            remoteAddress: req.socket.remoteAddress,
            requestedServerHostname,
          }
        );
        ws.close(1008, "Configuration serveur invalide");
        return;
      }

      const verificationResult = verifyToken(clientToken, hostname, serverIp);

      if (!verificationResult.valid) {
        // Token invalide : refuser la connexion
        // Raisons possibles :
        // - Token expiré (plus de 5 minutes)
        // - Signature invalide (token modifié ou secret incorrect)
        // - Hostname ou IP ne correspondent pas
        logger.warn("Tentative de connexion avec un token invalide", {
          remoteAddress: req.socket.remoteAddress,
          requestedServerHostname,
          error: verificationResult.error,
        });
        ws.close(1008, verificationResult.error || "Invalid token");
        return;
      }

      // Token valide : stocker le userId et companyId dans le contexte de la connexion WebSocket
      // pour pouvoir l'utiliser dans les actions pour vérifier les rôles
      const userId = verificationResult.userId;
      const companyId = verificationResult.companyId;
      ws.userId = userId; // Stocker le userId dans l'objet WebSocket
      ws.companyId = companyId; // Stocker le companyId dans l'objet WebSocket

      // Token valide : logger les informations pour traçabilité
      logger.info("Token vérifié avec succès localement", {
        remoteAddress: req.socket.remoteAddress,
        requestedServerHostname,
        userId,
        companyId,
      });
    } else if (token) {
      // Mode fallback : si un token statique est configuré dans l'environnement
      // mais qu'aucun token client n'est fourni, refuser la connexion
      // (ce mode est principalement pour le développement/test)
      logger.warn("Tentative de connexion sans token", {
        remoteAddress: req.socket.remoteAddress,
        requestedServerHostname,
      });
      ws.close(1008, "Token requis");
      return;
    } else {
      // Si aucun token n'est fourni ET aucun token statique n'est configuré,
      // on accepte la connexion (mode développement sans authentification)
      // Dans ce cas, userId et companyId seront undefined, ce qui empêchera les actions nécessitant une authentification
      logger.warn(
        "Connexion acceptée sans authentification (mode développement)",
        {
          remoteAddress: req.socket.remoteAddress,
          requestedServerHostname,
        }
      );
      ws.userId = undefined; // Pas de userId en mode développement
      ws.companyId = undefined; // Pas de companyId en mode développement
    }

    // ============================================
    // ÉTAPE 4 : Connexion acceptée - Initialisation
    // ============================================
    // Toutes les vérifications sont passées, la connexion est acceptée
    const remoteAddress = req.socket.remoteAddress;

    logger.info("Client frontend connecté", {
      remoteAddress,
      requestedServerHostname,
    });

    // Map pour suivre les ressources actives (streams, processus, etc.)
    // associées à cette connexion WebSocket
    // Clé : requestId (identifiant unique de la requête)
    // Valeur : ressource avec une méthode cleanup() pour libérer les ressources
    const activeResources = new Map();

    /**
     * Enregistre une ressource active associée à une requête
     *
     * Les ressources peuvent être :
     * - Streams de logs (journalctl, docker logs)
     * - Streams de métriques (collecte CPU, mémoire, etc.)
     * - Processus en cours d'exécution
     *
     * Si une ressource existe déjà pour ce requestId, elle est nettoyée avant
     * d'être remplacée (pour éviter les fuites de ressources).
     *
     * @param {string} requestId - Identifiant unique de la requête
     * @param {Object|null} resource - Ressource avec méthode cleanup(), ou null pour supprimer
     */
    const registerResource = (requestId, resource) => {
      if (!requestId) {
        return;
      }

      // Si une ressource existe déjà pour ce requestId, la nettoyer d'abord
      const existing = activeResources.get(requestId);
      if (existing?.cleanup) {
        try {
          existing.cleanup();
        } catch (error) {
          logger.warn("Erreur lors du nettoyage d'une ressource active", {
            error: error.message,
            requestId,
          });
        }
      }

      // Enregistrer la nouvelle ressource ou supprimer l'entrée si resource est null
      if (resource) {
        activeResources.set(requestId, resource);
      } else {
        activeResources.delete(requestId);
      }
    };

    /**
     * Nettoie toutes les ressources actives lors de la fermeture de la connexion
     *
     * Cette fonction est appelée quand :
     * - Le client ferme la connexion WebSocket
     * - Une erreur survient sur la connexion
     * - Le serveur est arrêté
     *
     * Elle garantit que toutes les ressources (processus, streams, etc.)
     * sont correctement libérées pour éviter les fuites mémoire.
     */
    const cleanupResources = () => {
      activeResources.forEach((resource, requestId) => {
        if (resource?.cleanup) {
          try {
            resource.cleanup();
          } catch (error) {
            logger.warn(
              "Erreur lors du nettoyage d'une ressource à la fermeture",
              {
                error: error.message,
                requestId,
              }
            );
          }
        }
      });
      activeResources.clear();
    };

    /**
     * Gestionnaire de messages WebSocket
     *
     * Ce handler traite tous les messages JSON reçus du frontend.
     * Format attendu : { id: "req-123", action: "module.action", params: {...} }
     *
     * Le message est délégué à handleMessage() qui :
     * - Valide l'action demandée
     * - Exécute l'action correspondante (docker, haproxy, metrics, etc.)
     * - Retourne une réponse ou démarre un stream
     */
    ws.on("message", async (rawData) => {
      let message;

      // Parser le message JSON
      try {
        message = JSON.parse(rawData.toString());
      } catch (error) {
        // Message JSON invalide : retourner une erreur au client
        logger.warn("Payload JSON invalide reçu du frontend", {
          error: error.message,
          remoteAddress,
        });
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify(createError("unknown", "Payload JSON invalide"))
          );
        }
        return;
      }

      // Vérifier que le message contient un identifiant de requête
      // L'ID permet de faire correspondre les réponses aux requêtes
      if (!message?.id) {
        logger.warn("Message reçu sans identifiant", {
          remoteAddress,
        });
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify(
              createError("unknown", "Identifiant de requête manquant")
            )
          );
        }
        return;
      }

      // Traiter le message via le handler principal
      try {
        await handleMessage(
          message,
          // Callback pour envoyer une réponse au client
          (response) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(response));
            }
          },
          // Callback pour enregistrer une ressource active (stream, processus, etc.)
          (requestId, resource) => {
            registerResource(requestId, resource);
          },
          // Contexte de la connexion (userId, companyId, etc.)
          {
            userId: ws.userId,
            companyId: ws.companyId,
          }
        );
      } catch (error) {
        // Erreur lors du traitement : logger et retourner une erreur au client
        logger.error("Erreur lors du traitement d'une requête frontend", {
          error: error.message,
          remoteAddress,
        });
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify(
              createError(message.id, error.message || "Erreur interne")
            )
          );
        }
      }
    });

    /**
     * Gestionnaire de fermeture de connexion
     *
     * Appelé quand le client ferme la connexion WebSocket ou quand
     * le serveur ferme la connexion (timeout, erreur, etc.)
     */
    ws.on("close", () => {
      // Nettoyer toutes les ressources actives (streams, processus, etc.)
      cleanupResources();
      logger.info("Client frontend déconnecté", {
        remoteAddress,
        requestedServerHostname,
      });
    });

    /**
     * Gestionnaire d'erreurs WebSocket
     *
     * Appelé en cas d'erreur sur la connexion WebSocket
     * (erreur réseau, protocole, etc.)
     */
    ws.on("error", (error) => {
      logger.error("Erreur WebSocket côté frontend", {
        error: error.message,
        remoteAddress,
        requestedServerHostname,
      });
      // Nettoyer les ressources même en cas d'erreur
      cleanupResources();
    });
  });

  server.listen(port, host, () => {
    logger.info("Serveur WebSocket frontend démarré", {
      port,
      host,
      healthcheckPath: normalizedHealthcheckPath,
    });
  });

  return {
    server,
    wss,
    close: () =>
      new Promise((resolve, reject) => {
        wss.clients.forEach((client) => {
          try {
            client.terminate();
          } catch (error) {
            logger.warn("Erreur lors de la terminaison d'un client", {
              error: error.message,
            });
          }
        });

        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

function normalizeHealthcheckPath(pathname) {
  if (!pathname) {
    return DEFAULT_HEALTHCHECK_PATH;
  }

  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function handleHttpRequest(req, res, healthcheckPath) {
  // Laisser les requêtes d'upgrade WebSocket être gérées par ws.
  if (req.headers.upgrade) {
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`
    );
  } catch (error) {
    logger.warn("Requête HTTP invalide reçue sur le serveur frontend", {
      error: error.message,
    });
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "error", message: "Invalid URL" }));
    return;
  }

  if (requestUrl.pathname !== healthcheckPath) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "error", message: "Not Found" }));
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, {
      "Content-Type": "application/json",
      Allow: "GET, HEAD",
    });
    res.end(JSON.stringify({ status: "error", message: "Method Not Allowed" }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  res.end(
    JSON.stringify({
      status: "ok",
      uptime: Number(process.uptime().toFixed(3)),
      timestamp: new Date().toISOString(),
    })
  );
}

