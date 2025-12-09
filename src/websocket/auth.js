/**
 * Module d'authentification pour les connexions WebSocket
 *
 * Ce module gère la vérification des tokens JWT envoyés par le frontend
 * en appelant l'API de vérification du backend devoups.
 *
 * Flux d'authentification :
 * 1. Le frontend génère un token JWT basé sur la session utilisateur (valide 2-3 minutes)
 * 2. Le frontend envoie ce token dans l'URL WebSocket : wss://...?token=xxx&hostname=yyy
 * 3. L'agent reçoit le token et appelle cette fonction pour le vérifier
 * 4. Cette fonction fait un appel HTTP à l'API backend pour valider le token
 * 5. L'API vérifie : signature JWT, expiration, existence de l'utilisateur
 * 6. Si valide, la connexion WebSocket est acceptée, sinon elle est refusée
 */

import http from "http";
import https from "https";
import { logger } from "../shared/logger.js";

// URL de l'API de vérification des tokens (backend devoups)
// Utiliser le slash final pour éviter la redirection 308 de Next.js
const API_VERIFY_URL = "https://devoups.elyamaje.com/api/token/";
// Timeout pour l'appel API (5 secondes max pour éviter de bloquer les connexions)
const VERIFY_TIMEOUT = 5000;

/**
 * Vérifie un token JWT via l'API de vérification du backend
 *
 * Cette fonction fait un appel HTTP GET à l'API backend pour vérifier :
 * - La signature du token JWT (authenticité)
 * - L'expiration du token (pas expiré)
 * - L'existence de l'utilisateur dans la base de données
 * - Le statut actif de l'utilisateur
 *
 * @param {string} token - Token JWT à vérifier (reçu dans l'URL WebSocket)
 * @returns {Promise<{valid: boolean, userId?: string, email?: string, error?: string}>}
 *   - valid: true si le token est valide, false sinon
 *   - userId: ID de l'utilisateur (si valide)
 *   - email: Email de l'utilisateur (si valide)
 *   - error: Message d'erreur (si invalide)
 *
 * @example
 * const result = await verifyToken("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...");
 * if (result.valid) {
 *   console.log(`Utilisateur authentifié: ${result.email}`);
 * } else {
 *   console.error(`Erreur: ${result.error}`);
 * }
 */
export async function verifyToken(token) {
  // Vérification basique : le token doit être fourni
  if (!token) {
    logger.warn("Token manquant lors de la vérification");
    return { valid: false, error: "Token manquant" };
  }

  // Vérifier que le token est une chaîne non vide
  if (typeof token !== "string" || token.trim().length === 0) {
    logger.warn("Token invalide (vide ou non-string)", { tokenType: typeof token });
    return { valid: false, error: "Token invalide" };
  }

  // Vérifier le format JWT basique (3 parties séparées par des points)
  const tokenParts = token.split(".");
  if (tokenParts.length !== 3) {
    logger.warn("Token JWT malformé", { parts: tokenParts.length });
    return { valid: false, error: "Token JWT malformé" };
  }

  // Construire l'URL de vérification avec le token en paramètre query
  const url = new URL(API_VERIFY_URL);
  url.searchParams.set("verify", token);
  
  logger.debug("Vérification du token", {
    tokenLength: token.length,
    tokenPreview: token.substring(0, 20) + "...",
    url: url.toString().replace(/verify=[^&]+/, "verify=***"), // Masquer le token dans les logs
  });

  // Retourner une Promise pour gérer l'appel HTTP asynchrone
  return new Promise((resolve) => {
    // Fonction récursive pour suivre les redirections
    const makeRequest = (requestUrl, redirectCount = 0) => {
      // Limiter le nombre de redirections pour éviter les boucles infinies
      if (redirectCount > 5) {
        logger.error("Trop de redirections lors de la vérification du token");
        resolve({ valid: false, error: "Trop de redirections" });
        return;
      }

      // Choisir le client HTTP approprié selon le protocole (https ou http)
      const client = requestUrl.protocol === "https:" ? https : http;

      // Options pour la requête HTTP avec les headers appropriés
      const options = {
        hostname: requestUrl.hostname,
        port: requestUrl.port || (requestUrl.protocol === "https:" ? 443 : 80),
        path: requestUrl.pathname + requestUrl.search,
        method: "GET",
        timeout: VERIFY_TIMEOUT,
        headers: {
          "User-Agent": "devoups-agent/1.0",
          "Accept": "application/json",
          "Accept-Encoding": "identity", // Pas de compression pour simplifier
        },
      };

      // Faire un appel GET à l'API de vérification
      const req = client.request(options, (res) => {
          // Gérer les redirections (301, 302, 307, 308) AVANT de lire le body
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            // Consommer le body de la redirection sans le parser (pour libérer la connexion)
            res.on("data", () => {});
            res.on("end", () => {
              // Suivre la redirection après avoir consommé le body
              try {
                // Construire l'URL de redirection
                // Si c'est une URL absolue, l'utiliser directement
                // Sinon, la construire relativement à l'URL de base
                let redirectUrl;
                if (
                  res.headers.location.startsWith("http://") ||
                  res.headers.location.startsWith("https://")
                ) {
                  redirectUrl = new URL(res.headers.location);
                } else {
                  // URL relative : la construire à partir de l'URL de base
                  redirectUrl = new URL(
                    res.headers.location,
                    `${requestUrl.protocol}//${requestUrl.host}`
                  );
                }

                // Préserver les paramètres de requête de l'URL originale
                // (important pour préserver le paramètre ?verify=token)
                if (requestUrl.search) {
                  redirectUrl.search = requestUrl.search;
                }

                logger.debug("Redirection suivie", {
                  from: requestUrl.toString(),
                  to: redirectUrl.toString(),
                  statusCode: res.statusCode,
                  locationHeader: res.headers.location,
                });
                // Réessayer avec la nouvelle URL
                makeRequest(redirectUrl, redirectCount + 1);
              } catch (error) {
                logger.error("Erreur lors du suivi de la redirection", {
                  error: error.message,
                  location: res.headers.location,
                  currentUrl: requestUrl.toString(),
                });
                resolve({ valid: false, error: "Erreur redirection" });
              }
            });
            return;
          }

          // Buffer pour accumuler les données de la réponse (seulement si ce n'est pas une redirection)
          let data = "";

          // Accumuler les chunks de données reçus
          res.on("data", (chunk) => {
            data += chunk;
          });

          // Quand toute la réponse est reçue, parser et vérifier
          res.on("end", () => {
            // Vérifier d'abord le code de statut HTTP
            // Codes 5xx : erreurs serveur (maintenance, erreur interne, etc.)
            if (res.statusCode >= 500) {
              logger.error("Erreur serveur lors de la vérification du token", {
                statusCode: res.statusCode,
                contentType: res.headers["content-type"],
                dataPreview: data.substring(0, 200),
              });
              resolve({
                valid: false,
                error: `Service indisponible (${res.statusCode})`,
              });
              return;
            }

            // Vérifier que la réponse n'est pas vide
            if (!data || data.trim().length === 0) {
              logger.error("Réponse API vide", {
                statusCode: res.statusCode,
              });
              resolve({ valid: false, error: "Réponse API vide" });
              return;
            }

            // Vérifier le Content-Type avant de parser en JSON
            const contentType = res.headers["content-type"] || "";
            if (!contentType.includes("application/json")) {
              logger.error("Réponse API n'est pas du JSON", {
                statusCode: res.statusCode,
                contentType,
                dataPreview: data.substring(0, 200),
              });
              resolve({
                valid: false,
                error: `Réponse API invalide (${res.statusCode})`,
              });
              return;
            }

            try {
              // Parser la réponse JSON de l'API
              const result = JSON.parse(data);

              // Vérifier que la réponse est un succès (200) et que le token est valide
              if (res.statusCode === 200 && result.valid === true) {
                // Token valide : logger les infos utilisateur et retourner le succès
                logger.debug("Token vérifié avec succès", {
                  userId: result.userId,
                  email: result.email,
                });
                resolve({
                  valid: true,
                  userId: result.userId,
                  email: result.email,
                });
              } else {
                // Token invalide : logger l'erreur et retourner l'échec
                // L'API peut retourner différents codes d'erreur :
                // - 401 : Token expiré ou signature invalide
                // - 404 : Utilisateur introuvable
                // - 403 : Utilisateur inactif
                logger.warn("Token invalide selon l'API", {
                  error: result.error,
                  statusCode: res.statusCode,
                });
                resolve({
                  valid: false,
                  error: result.error || "Token invalide",
                });
              }
            } catch (error) {
              // Erreur lors du parsing JSON : la réponse n'est pas valide
              logger.error("Erreur parsing réponse API", {
                error: error.message,
                data: data.substring(0, 200), // Logger seulement les 200 premiers caractères
                statusCode: res.statusCode,
                contentType: res.headers["content-type"],
              });
              resolve({ valid: false, error: "Erreur parsing réponse" });
            }
          });
        }
      );

      // Gérer les erreurs réseau (connexion impossible, DNS, etc.)
      req.on("error", (error) => {
        logger.error("Erreur réseau lors de la vérification du token", {
          error: error.message,
          code: error.code,
        });
        // En cas d'erreur réseau, on refuse la connexion par sécurité
        resolve({ valid: false, error: "Erreur réseau" });
      });

      // Gérer le timeout : si l'API ne répond pas dans les 5 secondes
      req.on("timeout", () => {
        req.destroy(); // Détruire la requête pour libérer les ressources
        logger.warn("Timeout lors de la vérification du token");
        // En cas de timeout, on refuse la connexion par sécurité
        resolve({ valid: false, error: "Timeout" });
      });

      // Configurer le timeout sur la requête
      req.setTimeout(VERIFY_TIMEOUT);

      // Envoyer la requête (nécessaire avec client.request())
      req.end();
    };

    // Démarrer la première requête
    makeRequest(url);
  });
}
