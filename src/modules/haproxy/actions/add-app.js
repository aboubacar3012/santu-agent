/**
 * Action add-app - Ajoute une application HAProxy avec génération automatique du certificat SSL
 * 
 * STRATÉGIE 1 : Utilisation de certbot en mode webroot au lieu de standalone
 * - HAProxy reste actif pendant la génération du certificat
 * - Un backend temporaire sert le répertoire webroot pour la validation ACME
 * - Pas d'interruption des autres applications utilisant HAProxy
 * 
 * STRATÉGIE 2 : Messages de progression (heartbeat)
 * - Envoi de messages de progression via onStream pour maintenir la connexion WebSocket active
 * - Informe l'utilisateur de l'avancement de l'opération
 *
 * @module modules/haproxy/actions/add-app
 */

import { logger } from "../../../shared/logger.js";
import { validateHaproxyParams } from "../validator.js";
import {
  executeHostCommand,
  hostFileExists,
  getHostFileSize,
} from "./utils.js";
import { requireRole } from "../../../websocket/auth.js";

/**
 * Ajoute une application HAProxy avec génération automatique du certificat SSL
 * @param {Object} params - Paramètres de l'application
 * @param {string} params.app_name - Nom de l'application
 * @param {string} params.app_domain - Domaine de l'application
 * @param {string} [params.app_backend_host] - Hôte backend (défaut: "127.0.0.1")
 * @param {number} params.app_backend_port - Port backend
 * @param {string} [params.app_slug] - Slug (généré automatiquement si non fourni)
 * @param {Object} [callbacks] - Callbacks pour streaming et ressources
 * @param {Function} [callbacks.onStream] - Callback pour envoyer des messages de progression
 * @param {Object} [callbacks.context] - Contexte de la connexion (userId, companyId)
 * @returns {Promise<Object>} Résultat de l'opération
 */
export async function addHaproxyApp(params = {}, callbacks = {}) {
  const startTime = Date.now();
  const { onStream } = callbacks;

  /**
   * Fonction helper pour envoyer des messages de progression
   * @param {number} step - Numéro de l'étape
   * @param {string} message - Message de progression
   */
  const sendProgress = (step, message) => {
    if (onStream && typeof onStream === "function") {
      try {
        onStream("progress", {
          step,
          message,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.warn("Erreur lors de l'envoi du message de progression", {
          error: error.message,
        });
      }
    }
    logger.info(`[ÉTAPE ${step}/11] ${message}`);
  };

  /**
   * Fonction helper pour gérer les erreurs avec rollback asynchrone
   * Envoie l'erreur immédiatement via sendProgress, puis fait le rollback de manière asynchrone
   * pour ne pas bloquer l'envoi de l'erreur au frontend
   * @param {number} step - Numéro de l'étape
   * @param {string} errorMsg - Message d'erreur
   * @param {Function} [cleanup] - Fonction de cleanup optionnelle à exécuter avant le rollback
   * @throws {Error} Lance l'erreur pour que le handler l'envoie au frontend
   */
  const handleErrorWithRollback = async (step, errorMsg, cleanup = null) => {
    // Envoyer l'erreur immédiatement via sendProgress pour que le frontend la reçoive
    sendProgress(step, `ERREUR: ${errorMsg}`);

    // Exécuter le cleanup si fourni
    if (cleanup && typeof cleanup === "function") {
      try {
        await cleanup();
      } catch (cleanupError) {
        logger.warn("Erreur lors du cleanup avant rollback", {
          error: cleanupError.message,
        });
      }
    }

    // Faire le rollback de manière asynchrone pour ne pas bloquer l'envoi de l'erreur
    rollbackState.rollbackExecuted = true;
    setImmediate(async () => {
      await rollback(new Error(errorMsg));
    });

    // Lancer l'erreur immédiatement pour que le handler l'envoie au frontend
    throw new Error(errorMsg);
  };

  // État initial et tracking pour le rollback
  const rollbackState = {
    haproxyWasActive: false,
    haproxyWasStopped: false,
    filesCreated: [],
    certCreated: false,
    certWasEmpty: false,
    legacyFileDeleted: false,
    // Fichiers temporaires pour le mode webroot
    webrootBackendCreated: false,
    webrootAclCreated: false,
    webrootDirCreated: false,
  };

  /**
   * Fonction de rollback : restaure l'état initial en cas d'erreur
   */
  const rollback = async (error) => {
    logger.info("=== ROLLBACK: Annulation des modifications ===");
    sendProgress(0, "Annulation des modifications en cours...");

    try {
      // 1. Supprimer tous les fichiers créés
      for (const filePath of rollbackState.filesCreated) {
        logger.info(`[ROLLBACK] Suppression du fichier: ${filePath}`);
        try {
          await executeHostCommand(`rm -f '${filePath}'`);
          logger.debug(`[ROLLBACK] Fichier supprimé: ${filePath}`);
        } catch (rmError) {
          logger.warn(`[ROLLBACK] Impossible de supprimer ${filePath}`, {
            error: rmError.message,
          });
        }
      }

      // 2. Supprimer les fichiers temporaires webroot si créés
      if (
        rollbackState.webrootBackendCreated &&
        rollbackState.webrootBackendPath
      ) {
        logger.info("[ROLLBACK] Suppression du backend webroot temporaire");
        try {
          await executeHostCommand(
            `rm -f '${rollbackState.webrootBackendPath}'`
          );
        } catch (rmError) {
          logger.warn("[ROLLBACK] Impossible de supprimer le backend webroot", {
            error: rmError.message,
          });
        }
      }

      if (rollbackState.webrootAclCreated && rollbackState.webrootAclPath) {
        logger.info("[ROLLBACK] Suppression de l'ACL webroot temporaire");
        try {
          await executeHostCommand(`rm -f '${rollbackState.webrootAclPath}'`);
        } catch (rmError) {
          logger.warn("[ROLLBACK] Impossible de supprimer l'ACL webroot", {
            error: rmError.message,
          });
        }
      }

      // 3. Recharger HAProxy si des fichiers temporaires ont été créés
      if (
        (rollbackState.webrootBackendCreated ||
          rollbackState.webrootAclCreated) &&
        rollbackState.haproxyWasActive
      ) {
        logger.info(
          "[ROLLBACK] Rechargement de HAProxy pour supprimer les configs temporaires"
        );
        try {
          await executeHostCommand(
            `systemctl reload ${rollbackState.haproxyServiceName}`
          );
        } catch (reloadError) {
          logger.warn("[ROLLBACK] Erreur lors du rechargement de HAProxy", {
            error: reloadError.message,
          });
        }
      }

      // 4. Restaurer le certificat vide si nécessaire
      if (rollbackState.certWasEmpty && rollbackState.certPath) {
        logger.info("[ROLLBACK] Restauration du certificat vide");
        try {
          await executeHostCommand(`touch '${rollbackState.certPath}'`);
        } catch (touchError) {
          logger.warn("[ROLLBACK] Impossible de restaurer le certificat vide", {
            error: touchError.message,
          });
        }
      }

      // 5. Restaurer le fichier legacy si nécessaire
      if (rollbackState.legacyFileDeleted && rollbackState.legacyPath) {
        logger.info("[ROLLBACK] Restauration du fichier legacy");
        try {
          await executeHostCommand(`touch '${rollbackState.legacyPath}'`);
        } catch (touchError) {
          logger.warn("[ROLLBACK] Impossible de restaurer le fichier legacy", {
            error: touchError.message,
          });
        }
      }

      // 6. Redémarrer HAProxy si nécessaire (seulement si arrêté, ce qui ne devrait plus arriver)
      if (rollbackState.haproxyWasStopped && rollbackState.haproxyWasActive) {
        logger.info("[ROLLBACK] Redémarrage de HAProxy");
        try {
          const startResult = await executeHostCommand(
            `systemctl start ${rollbackState.haproxyServiceName}`
          );
          if (startResult.error) {
            logger.error("[ROLLBACK] Erreur lors du redémarrage de HAProxy", {
              error: startResult.stderr,
            });
            const restartResult = await executeHostCommand(
              `systemctl restart ${rollbackState.haproxyServiceName}`
            );
            if (restartResult.error) {
              logger.error(
                "[ROLLBACK] Erreur lors du redémarrage complet de HAProxy",
                {
                  error: restartResult.stderr,
                }
              );
            } else {
              logger.info("[ROLLBACK] HAProxy redémarré avec succès (restart)");
            }
          } else {
            logger.info("[ROLLBACK] HAProxy redémarré avec succès");
          }
        } catch (startError) {
          logger.error("[ROLLBACK] Erreur lors du redémarrage de HAProxy", {
            error: startError.message,
          });
        }
      }

      logger.info("=== ROLLBACK TERMINÉ ===");
    } catch (rollbackError) {
      logger.error("=== ERREUR LORS DU ROLLBACK ===", {
        error: rollbackError.message,
        stack: rollbackError.stack,
      });
    }
  };

  try {
    // Vérifier les permissions : ADMIN, OWNER et EDITOR peuvent ajouter une application HAProxy
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER", "EDITOR"],
      "ajouter une application HAProxy"
    );

    logger.info("=== DÉBUT addHaproxyApp ===", { params });
    sendProgress(0, "Début de l'ajout de l'application HAProxy");

    // Valider les paramètres
    const validatedParams = validateHaproxyParams("add-app", params);
    const {
      app_name,
      app_domain,
      app_backend_host,
      app_backend_port,
      app_slug,
    } = validatedParams;

    logger.debug("Début de l'ajout d'une application HAProxy", {
      app_name,
      app_domain,
      app_backend_host,
      app_backend_port,
      app_slug,
    });

    // Constantes de configuration
    const letsencrypt_email = "equipe2elyamaje@gmail.com";
    const letsencrypt_live_dir = "/etc/letsencrypt/live";
    const haproxy_certs_dir = "/etc/haproxy/certs";
    const haproxy_acl_dir = "/etc/haproxy/conf.d/acls";
    const haproxy_backend_dir = "/etc/haproxy/conf.d/backends";
    const haproxy_service_name = "haproxy";

    // Répertoire webroot pour certbot (mode webroot)
    // Let's Encrypt valide en accédant à http://domain/.well-known/acme-challenge/token
    const webroot_dir = "/var/www/html";
    const acme_challenge_dir = `${webroot_dir}/.well-known/acme-challenge`;

    // Sauvegarder le nom du service pour le rollback
    rollbackState.haproxyServiceName = haproxy_service_name;

    // 1. Vérifier l'état initial de HAProxy
    sendProgress(1, "Vérification de l'état de HAProxy");
    const haproxyStateResult = await executeHostCommand(
      `systemctl is-active ${haproxy_service_name} || echo 'inactive'`
    );
    const haproxyInitialState = haproxyStateResult.stdout.trim();
    const isHaproxyActive = haproxyInitialState === "active";
    rollbackState.haproxyWasActive = isHaproxyActive;

    logger.info("[ÉTAPE 1/11] État initial de HAProxy", {
      state: haproxyInitialState,
      isActive: isHaproxyActive,
    });

    if (!isHaproxyActive) {
      const errorMsg =
        "HAProxy n'est pas actif. Veuillez d'abord installer HAProxy.";
      sendProgress(1, `Erreur: ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // 2. Créer les répertoires nécessaires
    sendProgress(2, "Création des répertoires nécessaires");
    for (const dir of [
      haproxy_certs_dir,
      haproxy_acl_dir,
      haproxy_backend_dir,
      webroot_dir,
      acme_challenge_dir,
    ]) {
      logger.debug(`[ÉTAPE 2/11] Création du répertoire: ${dir}`);
      const mkdirResult = await executeHostCommand(
        `mkdir -p '${dir}' && chmod 755 '${dir}'`
      );
      if (mkdirResult.error) {
        const errorMsg = `Erreur lors de la création du répertoire ${dir}: ${mkdirResult.stderr}`;
        logger.error(`[ÉTAPE 2/11] ${errorMsg}`);
        handleErrorWithRollback(2, errorMsg);
      }
      logger.debug(`[ÉTAPE 2/11] Répertoire créé: ${dir}`);

      // Marquer le répertoire webroot comme créé pour le rollback
      if (dir === acme_challenge_dir) {
        rollbackState.webrootDirCreated = true;
      }
    }
    logger.info("[ÉTAPE 2/11] Répertoires créés");

    // 3. Vérifier si le certificat existe déjà
    sendProgress(3, "Vérification du certificat existant");
    const certPath = `${haproxy_certs_dir}/${app_domain}.pem`;
    rollbackState.certPath = certPath;
    logger.debug(`[ÉTAPE 3/11] Vérification du fichier: ${certPath}`);
    const certExists = await hostFileExists(certPath);
    const certSize = certExists ? await getHostFileSize(certPath) : 0;
    logger.info("[ÉTAPE 3/11] État du certificat", {
      exists: certExists,
      size: certSize,
    });

    // 4. Supprimer un certificat vide ou corrompu
    if (certExists && certSize === 0) {
      sendProgress(4, "Suppression du certificat vide ou corrompu");
      rollbackState.certWasEmpty = true;
      const rmResult = await executeHostCommand(`rm -f '${certPath}'`);
      if (rmResult.error) {
        const errorMsg = `Erreur lors de la suppression du certificat vide: ${rmResult.stderr}`;
        logger.error(`[ÉTAPE 4/11] ${errorMsg}`);
        handleErrorWithRollback(4, errorMsg);
      }
      logger.info("[ÉTAPE 4/11] Certificat vide supprimé");
    } else {
      sendProgress(4, "Pas de certificat vide à supprimer");
      logger.info("[ÉTAPE 4/11] Pas de certificat vide à supprimer");
    }

    // 5. Supprimer l'ancien fichier legacy
    sendProgress(5, "Vérification des fichiers legacy");
    const legacyPath = `/etc/haproxy/conf.d/apps/${app_slug}.cfg`;
    rollbackState.legacyPath = legacyPath;
    const legacyExists = await hostFileExists(legacyPath);
    if (legacyExists) {
      sendProgress(5, "Suppression de l'ancien fichier legacy");
      rollbackState.legacyFileDeleted = true;
      const rmResult = await executeHostCommand(`rm -f '${legacyPath}'`);
      if (rmResult.error) {
        const errorMsg = `Erreur lors de la suppression du fichier legacy: ${rmResult.stderr}`;
        logger.error(`[ÉTAPE 5/11] ${errorMsg}`);
        handleErrorWithRollback(5, errorMsg);
      }
      logger.info("[ÉTAPE 5/11] Fichier legacy supprimé");
    } else {
      sendProgress(5, "Pas de fichier legacy à supprimer");
      logger.info("[ÉTAPE 5/11] Pas de fichier legacy à supprimer");
    }

    // 6. Générer le certificat si nécessaire (MODE WEBROOT - HAProxy reste actif)
    const needsCert = !certExists || certSize === 0;
    logger.info("[ÉTAPE 6/11] Génération certificat nécessaire?", {
      needsCert,
    });

    if (needsCert) {
      sendProgress(
        6,
        "Génération du certificat SSL en mode webroot (HAProxy reste actif)"
      );

      // 6.1. Créer un backend HAProxy temporaire pour servir le webroot
      // Ce backend servira les fichiers de validation ACME via HTTP
      sendProgress(
        6,
        "Configuration du backend temporaire pour la validation ACME"
      );

      const webrootBackendName = `acme_challenge_backend_${app_slug}`;
      const webrootBackendPath = `${haproxy_backend_dir}/${webrootBackendName}.cfg`;
      rollbackState.webrootBackendPath = webrootBackendPath;

      // Backend qui sert les fichiers statiques depuis le répertoire webroot
      // On utilise un serveur HTTP simple (python3 -m http.server) ou nginx si disponible
      // Pour simplifier, on va créer un backend qui pointe vers un serveur HTTP local
      // qui servira le répertoire webroot

      // Vérifier si un serveur HTTP simple est disponible pour servir le webroot
      // On va utiliser python3 -m http.server sur un port temporaire
      const webrootServerPort = 8888;

      // Démarrer un serveur HTTP simple pour servir le webroot
      // Note: Ce serveur sera arrêté après la génération du certificat
      sendProgress(6, "Démarrage du serveur HTTP temporaire pour le webroot");

      const startWebrootServerResult = await executeHostCommand(
        `cd '${webroot_dir}' && nohup python3 -m http.server ${webrootServerPort} > /dev/null 2>&1 & echo $!`
      );

      let webrootServerPid = null;
      if (
        !startWebrootServerResult.error &&
        startWebrootServerResult.stdout.trim()
      ) {
        webrootServerPid = startWebrootServerResult.stdout.trim();
        logger.info(
          `[ÉTAPE 6/11] Serveur HTTP webroot démarré (PID: ${webrootServerPid})`
        );
      } else {
        // Essayer avec python si python3 n'est pas disponible
        const startWebrootServerResult2 = await executeHostCommand(
          `cd '${webroot_dir}' && nohup python -m SimpleHTTPServer ${webrootServerPort} > /dev/null 2>&1 & echo $!`
        );
        if (
          !startWebrootServerResult2.error &&
          startWebrootServerResult2.stdout.trim()
        ) {
          webrootServerPid = startWebrootServerResult2.stdout.trim();
          logger.info(
            `[ÉTAPE 6/11] Serveur HTTP webroot démarré avec python (PID: ${webrootServerPid})`
          );
        } else {
          // Si aucun serveur HTTP n'est disponible, on va utiliser nginx ou créer un backend différent
          // Pour l'instant, on va essayer de continuer et voir si certbot peut fonctionner
          logger.warn(
            "[ÉTAPE 6/11] Impossible de démarrer un serveur HTTP pour le webroot"
          );
        }
      }

      // Créer le backend HAProxy pour servir le webroot
      const webrootBackendContent = `# Backend temporaire pour la validation ACME (Let's Encrypt)
# Ce backend sert les fichiers de validation depuis le répertoire webroot
backend ${webrootBackendName}
    mode http
    option http-server-close
    # Rediriger vers le serveur HTTP local qui sert le webroot
    server webroot_server 127.0.0.1:${webrootServerPort} check
`;

      const webrootBackendEscaped = webrootBackendContent
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "'\"'\"'")
        .replace(/\$/g, "\\$")
        .replace(/`/g, "\\`");

      const webrootBackendResult = await executeHostCommand(
        `printf '%s' '${webrootBackendEscaped}' > '${webrootBackendPath}' && chmod 644 '${webrootBackendPath}'`
      );

      if (webrootBackendResult.error) {
        const errorMsg = `Erreur lors de la création du backend webroot: ${webrootBackendResult.stderr}`;
        logger.error(`[ÉTAPE 6/11] ${errorMsg}`);
        await handleErrorWithRollback(6, errorMsg, async () => {
          // Arrêter le serveur HTTP si démarré
          if (webrootServerPid) {
            await executeHostCommand(
              `kill ${webrootServerPid} 2>/dev/null || true`
            );
          }
        });
      }
      rollbackState.webrootBackendCreated = true;
      rollbackState.filesCreated.push(webrootBackendPath);
      logger.info("[ÉTAPE 6/11] Backend webroot créé");

      // 6.2. Créer une ACL temporaire pour router les requêtes ACME vers le backend webroot
      sendProgress(
        6,
        "Configuration de l'ACL temporaire pour la validation ACME"
      );

      const webrootAclName = `acme_challenge_acl_${app_slug}`;
      const webrootAclPath = `${haproxy_acl_dir}/${webrootAclName}.cfg`;
      rollbackState.webrootAclPath = webrootAclPath;

      // ACL qui capture les requêtes vers /.well-known/acme-challenge/
      const webrootAclContent = `# ACL temporaire pour la validation ACME (Let's Encrypt)
# Cette ACL route les requêtes de validation vers le backend webroot
    acl ${webrootAclName} path_beg -i /.well-known/acme-challenge/
    use_backend ${webrootBackendName} if ${webrootAclName}
`;

      const webrootAclEscaped = webrootAclContent
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "'\"'\"'")
        .replace(/\$/g, "\\$")
        .replace(/`/g, "\\`");

      const webrootAclResult = await executeHostCommand(
        `printf '%s' '${webrootAclEscaped}' > '${webrootAclPath}' && chmod 644 '${webrootAclPath}'`
      );

      if (webrootAclResult.error) {
        const errorMsg = `Erreur lors de la création de l'ACL webroot: ${webrootAclResult.stderr}`;
        logger.error(`[ÉTAPE 6/11] ${errorMsg}`);
        await handleErrorWithRollback(6, errorMsg, async () => {
          // Arrêter le serveur HTTP si démarré
          if (webrootServerPid) {
            await executeHostCommand(
              `kill ${webrootServerPid} 2>/dev/null || true`
            );
          }
        });
      }
      rollbackState.webrootAclCreated = true;
      rollbackState.filesCreated.push(webrootAclPath);
      logger.info("[ÉTAPE 6/11] ACL webroot créée");

      // 6.3. Recharger HAProxy pour activer le backend et l'ACL temporaires
      sendProgress(
        6,
        "Rechargement de HAProxy pour activer la configuration temporaire"
      );
      const reloadResult = await executeHostCommand(
        `systemctl reload ${haproxy_service_name}`
      );
      if (reloadResult.error) {
        const errorMsg = `Erreur lors du rechargement de HAProxy: ${reloadResult.stderr}`;
        logger.error(`[ÉTAPE 6/11] ${errorMsg}`);
        await handleErrorWithRollback(6, errorMsg, async () => {
          // Arrêter le serveur HTTP si démarré
          if (webrootServerPid) {
            await executeHostCommand(
              `kill ${webrootServerPid} 2>/dev/null || true`
            );
          }
        });
      }
      logger.info("[ÉTAPE 6/11] HAProxy rechargé avec succès");

      // Attendre un peu pour que HAProxy soit prêt
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 6.4. Générer le certificat Let's Encrypt en mode webroot
      sendProgress(
        6,
        `Génération du certificat SSL pour ${app_domain} (cela peut prendre 1-2 minutes)`
      );

      const certbotStartTime = Date.now();

      // Démarrer un intervalle de heartbeat pour maintenir la connexion WebSocket active
      const heartbeatInterval = setInterval(() => {
        sendProgress(6, "Génération du certificat en cours... (patientez)");
      }, 30000); // Toutes les 30 secondes

      // Commande certbot en mode webroot
      // --webroot-path spécifie le répertoire où certbot va placer les fichiers de validation
      const certbotPromise = executeHostCommand(
        `certbot certonly --webroot --webroot-path=${webroot_dir} --non-interactive --agree-tos --email ${letsencrypt_email} -d ${app_domain}`,
        { timeout: 300000 } // 5 minutes pour certbot
      );

      // Timeout de sécurité supplémentaire (6 minutes)
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(
            new Error("Timeout: certbot a pris trop de temps (> 6 minutes)")
          );
        }, 360000); // 6 minutes
      });

      let certbotResult;
      try {
        logger.info("[ÉTAPE 6/11] Attente de la réponse de certbot...");
        certbotResult = await Promise.race([certbotPromise, timeoutPromise]);
        clearInterval(heartbeatInterval); // Arrêter le heartbeat

        const certbotDuration = Date.now() - certbotStartTime;
        logger.info("[ÉTAPE 6/11] Certbot a terminé", {
          duration: `${certbotDuration}ms`,
          hasError: certbotResult.error,
          stdoutLength: certbotResult.stdout?.length || 0,
          stderrLength: certbotResult.stderr?.length || 0,
        });
      } catch (error) {
        clearInterval(heartbeatInterval); // Arrêter le heartbeat en cas d'erreur

        const certbotDuration = Date.now() - certbotStartTime;
        const errorMsg = `Certbot n'a pas généré le certificat pour ${app_domain}: ${error.message}. Vérifiez DNS et que le domaine pointe vers ce serveur.`;
        logger.error("[ÉTAPE 6/11] Erreur certbot", {
          error: error.message,
          duration: `${certbotDuration}ms`,
        });

        // Envoyer l'erreur immédiatement via sendProgress pour que le frontend la reçoive
        sendProgress(6, `ERREUR: ${errorMsg}`);

        // Arrêter le serveur HTTP si démarré
        if (webrootServerPid) {
          await executeHostCommand(
            `kill ${webrootServerPid} 2>/dev/null || true`
          );
        }

        // Faire le rollback de manière asynchrone pour ne pas bloquer l'envoi de l'erreur
        // L'erreur sera envoyée par le handler avant que le rollback ne commence
        rollbackState.rollbackExecuted = true;
        setImmediate(async () => {
          await rollback(new Error(errorMsg));
        });

        // Lancer l'erreur immédiatement pour que le handler l'envoie au frontend
        throw new Error(errorMsg);
      }

      // Vérifier les erreurs certbot
      if (
        certbotResult.error ||
        certbotResult.stderr.includes("error") ||
        certbotResult.stderr.includes("Error") ||
        certbotResult.stderr.includes("Failed") ||
        (!certbotResult.stdout.includes("Successfully") &&
          certbotResult.stderr.length > 0)
      ) {
        // Construire le message d'erreur détaillé
        const errorDetails =
          certbotResult.stderr ||
          certbotResult.stdout ||
          "Aucun détail disponible";
        const errorMsg = `Certbot n'a pas généré le certificat pour ${app_domain}. Vérifiez DNS et que le domaine pointe vers ce serveur. Détails: ${errorDetails}`;

        logger.error("[ÉTAPE 6/11] Erreur certbot", {
          stdout: certbotResult.stdout,
          stderr: certbotResult.stderr,
          hasError: certbotResult.error,
        });

        // Envoyer l'erreur immédiatement via sendProgress pour que le frontend la reçoive
        sendProgress(6, `ERREUR: ${errorMsg}`);

        // Arrêter le serveur HTTP si démarré
        if (webrootServerPid) {
          await executeHostCommand(
            `kill ${webrootServerPid} 2>/dev/null || true`
          );
        }

        // Faire le rollback de manière asynchrone pour ne pas bloquer l'envoi de l'erreur
        // L'erreur sera envoyée par le handler avant que le rollback ne commence
        rollbackState.rollbackExecuted = true;
        setImmediate(async () => {
          await rollback(new Error(errorMsg));
        });

        // Lancer l'erreur immédiatement pour que le handler l'envoie au frontend
        throw new Error(errorMsg);
      }

      logger.debug("Certbot a terminé avec succès", {
        stdout: certbotResult.stdout.substring(0, 500),
      });
      sendProgress(6, "Certificat SSL généré avec succès");

      // Arrêter le serveur HTTP temporaire
      if (webrootServerPid) {
        logger.info(
          `[ÉTAPE 6/11] Arrêt du serveur HTTP webroot (PID: ${webrootServerPid})`
        );
        await executeHostCommand(
          `kill ${webrootServerPid} 2>/dev/null || true`
        );
      }

      // 6.5. Supprimer les fichiers temporaires webroot (backend et ACL)
      sendProgress(6, "Nettoyage des fichiers temporaires de validation");
      await executeHostCommand(`rm -f '${webrootBackendPath}'`);
      await executeHostCommand(`rm -f '${webrootAclPath}'`);

      // Retirer des fichiers créés pour le rollback
      rollbackState.filesCreated = rollbackState.filesCreated.filter(
        (f) => f !== webrootBackendPath && f !== webrootAclPath
      );
      rollbackState.webrootBackendCreated = false;
      rollbackState.webrootAclCreated = false;

      // Recharger HAProxy pour supprimer les configs temporaires
      const reloadAfterCleanupResult = await executeHostCommand(
        `systemctl reload ${haproxy_service_name}`
      );
      if (reloadAfterCleanupResult.error) {
        logger.warn(
          "[ÉTAPE 6/11] Erreur lors du rechargement après nettoyage",
          {
            error: reloadAfterCleanupResult.stderr,
          }
        );
      }

      // Concaténer fullchain + privkey en PEM HAProxy
      sendProgress(6, "Concaténation du certificat PEM");
      const concatResult = await executeHostCommand(
        `cat '${letsencrypt_live_dir}/${app_domain}/fullchain.pem' '${letsencrypt_live_dir}/${app_domain}/privkey.pem' > '${certPath}'`
      );

      if (concatResult.error) {
        const errorMsg = `Erreur lors de la création du certificat PEM: ${concatResult.stderr}`;
        logger.error(`[ÉTAPE 6/11] ${errorMsg}`);
        await handleErrorWithRollback(6, errorMsg);
      }
      rollbackState.filesCreated.push(certPath);
      rollbackState.certCreated = true;
      logger.info("[ÉTAPE 6/11] Certificat PEM concaténé");

      // Définir les permissions du certificat
      sendProgress(6, "Définition des permissions du certificat");
      const chmodResult = await executeHostCommand(`chmod 600 '${certPath}'`);
      if (chmodResult.error) {
        const errorMsg = `Erreur lors de la définition des permissions du certificat: ${chmodResult.stderr}`;
        logger.error(`[ÉTAPE 6/11] ${errorMsg}`);
        await handleErrorWithRollback(6, errorMsg);
      }
      sendProgress(6, "Certificat SSL généré et configuré avec succès");
      logger.info("[ÉTAPE 6/11] Certificat généré avec succès");
    } else {
      // 7. Régénérer le PEM si le certificat Let's Encrypt existe mais le PEM est vide
      sendProgress(6, "Vérification du certificat Let's Encrypt existant");
      const letsencryptCertPath = `${letsencrypt_live_dir}/${app_domain}/fullchain.pem`;
      const letsencryptCertExists = await hostFileExists(letsencryptCertPath);

      if (letsencryptCertExists && (!certExists || certSize === 0)) {
        sendProgress(6, "Régénération du certificat PEM depuis Let's Encrypt");
        const regenResult = await executeHostCommand(
          `cat '${letsencrypt_live_dir}/${app_domain}/fullchain.pem' '${letsencrypt_live_dir}/${app_domain}/privkey.pem' > '${certPath}'`
        );
        if (regenResult.error) {
          const errorMsg = `Erreur lors de la régénération du certificat PEM: ${regenResult.stderr}`;
          logger.error(`[ÉTAPE 6/11] ${errorMsg}`);
          await handleErrorWithRollback(6, errorMsg);
        }
        rollbackState.filesCreated.push(certPath);
        rollbackState.certCreated = true;

        const chmodResult = await executeHostCommand(`chmod 600 '${certPath}'`);
        if (chmodResult.error) {
          const errorMsg = `Erreur lors de la définition des permissions du certificat: ${chmodResult.stderr}`;
          logger.error(`[ÉTAPE 6/11] ${errorMsg}`);
          await handleErrorWithRollback(6, errorMsg);
        }
        sendProgress(6, "Certificat PEM régénéré avec succès");
      } else {
        sendProgress(
          6,
          "Certificat existant valide, pas de régénération nécessaire"
        );
      }
    }

    // 8. Créer le fichier ACL
    sendProgress(8, "Création du fichier ACL pour le routage");
    const aclContent = `# ==========================================
# ACL et routage pour ${app_name}
# ==========================================
    acl host_${app_slug} hdr(host) -i ${app_domain}
    use_backend ${app_slug}_backend if host_${app_slug}
`;
    const aclPath = `${haproxy_acl_dir}/${app_slug}.cfg`;
    const aclEscaped = aclContent
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "'\"'\"'")
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");
    const aclResult = await executeHostCommand(
      `printf '%s' '${aclEscaped}' > '${aclPath}' && chmod 644 '${aclPath}'`
    );

    if (aclResult.error) {
      const errorMsg = `Erreur lors de la création du fichier ACL: ${aclResult.stderr}`;
      logger.error(`[ÉTAPE 8/11] ${errorMsg}`);
      await handleErrorWithRollback(8, errorMsg);
    }
    rollbackState.filesCreated.push(aclPath);
    sendProgress(8, "Fichier ACL créé avec succès");
    logger.info("[ÉTAPE 8/11] Fichier ACL créé avec succès");

    // 9. Créer le fichier backend
    sendProgress(9, "Création du fichier backend");
    const backendContent = `# ==========================================
# Backend ${app_name}
# ==========================================
backend ${app_slug}_backend
    mode http
    option http-server-close
    option forwardfor
    server ${app_slug} ${app_backend_host}:${app_backend_port} check
`;
    const backendPath = `${haproxy_backend_dir}/${app_slug}.cfg`;
    const backendEscaped = backendContent
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "'\"'\"'")
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");
    const backendResult = await executeHostCommand(
      `printf '%s' '${backendEscaped}' > '${backendPath}' && chmod 644 '${backendPath}'`
    );

    if (backendResult.error) {
      const errorMsg = `Erreur lors de la création du fichier backend: ${backendResult.stderr}`;
      logger.error(`[ÉTAPE 9/11] ${errorMsg}`);
      await handleErrorWithRollback(9, errorMsg);
    }
    rollbackState.filesCreated.push(backendPath);
    sendProgress(9, "Fichier backend créé avec succès");
    logger.info("[ÉTAPE 9/11] Fichier backend créé avec succès");

    // 10. Vérifier les dates d'expiration du certificat
    sendProgress(10, "Vérification des dates d'expiration du certificat");
    const finalCertExists = await hostFileExists(certPath);
    const finalCertSize = finalCertExists ? await getHostFileSize(certPath) : 0;
    let certDates = null;

    if (finalCertExists && finalCertSize > 0) {
      try {
        const opensslResult = await executeHostCommand(
          `openssl x509 -in '${certPath}' -noout -dates`
        );
        if (!opensslResult.error) {
          certDates = opensslResult.stdout;
        }
      } catch (error) {
        logger.warn(
          "Impossible de récupérer les dates d'expiration du certificat",
          {
            error: error.message,
          }
        );
      }
    }

    logger.info("[ÉTAPE 10/11] Dates d'expiration récupérées", { certDates });
    sendProgress(10, "Dates d'expiration du certificat récupérées");

    // 11. Recharger HAProxy pour activer la nouvelle configuration
    sendProgress(
      11,
      "Rechargement de HAProxy pour activer la nouvelle configuration"
    );
    logger.info("[ÉTAPE 11/11] Rechargement de HAProxy");

    const reloadResult = await executeHostCommand(
      `systemctl reload ${haproxy_service_name}`
    );
    if (reloadResult.error) {
      logger.warn(
        "Erreur lors du rechargement de HAProxy, tentative de redémarrage",
        {
          error: reloadResult.stderr,
        }
      );
      sendProgress(11, "Rechargement échoué, tentative de redémarrage complet");
      // Si reload échoue, essayer restart
      const restartResult = await executeHostCommand(
        `systemctl restart ${haproxy_service_name}`
      );
      if (restartResult.error) {
        const errorMsg = `Erreur lors du redémarrage de HAProxy: ${restartResult.stderr}`;
        logger.error(`[ÉTAPE 11/11] ${errorMsg}`);
        await handleErrorWithRollback(11, errorMsg);
      } else {
        sendProgress(11, "HAProxy redémarré avec succès");
        logger.info("[ÉTAPE 11/11] HAProxy redémarré avec succès (restart)");
      }
    } else {
      sendProgress(11, "Configuration HAProxy rechargée avec succès");
      logger.info("[ÉTAPE 11/11] Configuration HAProxy rechargée avec succès");
    }

    const duration = Date.now() - startTime;
    logger.info("=== SUCCÈS addHaproxyApp ===", {
      app_name,
      app_domain,
      duration: `${duration}ms`,
    });
    sendProgress(11, `Application ${app_name} ajoutée avec succès !`);

    return {
      success: true,
      app_name,
      app_domain,
      app_slug,
      cert_dates: certDates,
      message: `Configuration HAProxy déployée pour ${app_name}`,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error("=== ERREUR addHaproxyApp ===", {
      error: error.message,
      stack: error.stack,
      duration: `${duration}ms`,
    });

    // Envoyer l'erreur finale via sendProgress pour que le frontend la reçoive
    sendProgress(0, `ERREUR FINALE: ${error.message}`);

    // Le rollback a déjà été effectué dans les blocs catch individuels
    // Mais on le refait ici au cas où une erreur surviendrait ailleurs
    // Faire le rollback de manière asynchrone pour ne pas bloquer l'envoi de l'erreur
    if (!rollbackState.rollbackExecuted) {
      rollbackState.rollbackExecuted = true;
      setImmediate(async () => {
        await rollback(error);
      });
    }

    // Relancer l'erreur avec le message exact pour que le handler l'envoie au frontend
    throw error;
  }
}
