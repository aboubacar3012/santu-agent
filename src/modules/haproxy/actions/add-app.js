/**
 * Action add-app - Ajoute une application HAProxy avec génération automatique du certificat SSL
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
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Résultat de l'opération
 */
export async function addHaproxyApp(params = {}, callbacks = {}) {
  const startTime = Date.now();

  // État initial et tracking pour le rollback
  const rollbackState = {
    haproxyWasActive: false,
    haproxyWasStopped: false,
    filesCreated: [],
    certCreated: false,
    certWasEmpty: false,
    legacyFileDeleted: false,
  };

  /**
   * Fonction de rollback : restaure l'état initial en cas d'erreur
   */
  const rollback = async (error) => {
    logger.info("=== ROLLBACK: Annulation des modifications ===");

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

      // 2. Restaurer le certificat vide si nécessaire
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

      // 3. Restaurer le fichier legacy si nécessaire
      if (rollbackState.legacyFileDeleted && rollbackState.legacyPath) {
        logger.info("[ROLLBACK] Restauration du fichier legacy");
        // Note: On ne peut pas restaurer le contenu, mais on crée un fichier vide
        // pour éviter les erreurs de configuration
        try {
          await executeHostCommand(`touch '${rollbackState.legacyPath}'`);
        } catch (touchError) {
          logger.warn("[ROLLBACK] Impossible de restaurer le fichier legacy", {
            error: touchError.message,
          });
        }
      }

      // 4. Redémarrer HAProxy si nécessaire
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
            // Essayer un restart complet si start échoue
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

    const letsencrypt_email = "equipe2elyamaje@gmail.com";
    const letsencrypt_live_dir = "/etc/letsencrypt/live";
    const haproxy_certs_dir = "/etc/haproxy/certs";
    const haproxy_acl_dir = "/etc/haproxy/conf.d/acls";
    const haproxy_backend_dir = "/etc/haproxy/conf.d/backends";
    const haproxy_service_name = "haproxy";

    // Sauvegarder le nom du service pour le rollback
    rollbackState.haproxyServiceName = haproxy_service_name;

    // 1. Vérifier l'état initial de HAProxy
    logger.info("[ÉTAPE 1/11] Vérification de l'état de HAProxy");
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

    // 2. Créer les répertoires nécessaires
    logger.info("[ÉTAPE 2/11] Création des répertoires nécessaires");
    for (const dir of [
      haproxy_certs_dir,
      haproxy_acl_dir,
      haproxy_backend_dir,
    ]) {
      logger.debug(`[ÉTAPE 2/11] Création du répertoire: ${dir}`);
      const mkdirResult = await executeHostCommand(
        `mkdir -p '${dir}' && chmod 755 '${dir}'`
      );
      if (mkdirResult.error) {
        const errorMsg = `Erreur lors de la création du répertoire ${dir}: ${mkdirResult.stderr}`;
        logger.error(`[ÉTAPE 2/11] ${errorMsg}`);
        await rollback(new Error(errorMsg));
        throw new Error(errorMsg);
      }
      logger.debug(`[ÉTAPE 2/11] Répertoire créé: ${dir}`);
    }
    logger.info("[ÉTAPE 2/11] Répertoires créés");

    // 3. Vérifier si le certificat existe déjà
    logger.info("[ÉTAPE 3/11] Vérification du certificat existant");
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
      logger.info("[ÉTAPE 4/11] Suppression du certificat vide");
      rollbackState.certWasEmpty = true;
      const rmResult = await executeHostCommand(`rm -f '${certPath}'`);
      if (rmResult.error) {
        const errorMsg = `Erreur lors de la suppression du certificat vide: ${rmResult.stderr}`;
        logger.error(`[ÉTAPE 4/11] ${errorMsg}`);
        await rollback(new Error(errorMsg));
        throw new Error(errorMsg);
      }
      logger.info("[ÉTAPE 4/11] Certificat vide supprimé");
    } else {
      logger.info("[ÉTAPE 4/11] Pas de certificat vide à supprimer");
    }

    // 5. Supprimer l'ancien fichier legacy
    logger.info("[ÉTAPE 5/11] Vérification des fichiers legacy");
    const legacyPath = `/etc/haproxy/conf.d/apps/${app_slug}.cfg`;
    rollbackState.legacyPath = legacyPath;
    const legacyExists = await hostFileExists(legacyPath);
    if (legacyExists) {
      logger.info("[ÉTAPE 5/11] Suppression de l'ancien fichier legacy");
      rollbackState.legacyFileDeleted = true;
      const rmResult = await executeHostCommand(`rm -f '${legacyPath}'`);
      if (rmResult.error) {
        const errorMsg = `Erreur lors de la suppression du fichier legacy: ${rmResult.stderr}`;
        logger.error(`[ÉTAPE 5/11] ${errorMsg}`);
        await rollback(new Error(errorMsg));
        throw new Error(errorMsg);
      }
      logger.info("[ÉTAPE 5/11] Fichier legacy supprimé");
    } else {
      logger.info("[ÉTAPE 5/11] Pas de fichier legacy à supprimer");
    }

    // 6. Générer le certificat si nécessaire
    logger.info(
      "[ÉTAPE 6/11] Vérification si génération certificat nécessaire"
    );
    const needsCert = !certExists || certSize === 0;
    logger.info("[ÉTAPE 6/11] Génération certificat nécessaire?", {
      needsCert,
    });

    if (needsCert) {
      logger.info("[ÉTAPE 6/11] Génération du certificat SSL nécessaire");

      // Arrêter HAProxy si actif
      if (isHaproxyActive) {
        logger.info("[ÉTAPE 6/11] Arrêt de HAProxy pour certbot");
        const stopResult = await executeHostCommand(
          `systemctl stop ${haproxy_service_name}`
        );
        if (stopResult.error) {
          const errorMsg = `Erreur lors de l'arrêt de HAProxy: ${stopResult.stderr}`;
          logger.error(`[ÉTAPE 6/11] ${errorMsg}`);
          await rollback(new Error(errorMsg));
          throw new Error(errorMsg);
        }
        rollbackState.haproxyWasStopped = true;
        logger.info("[ÉTAPE 6/11] HAProxy arrêté");
      } else {
        logger.info(
          "[ÉTAPE 6/11] HAProxy déjà arrêté, pas besoin de l'arrêter"
        );
      }

      // Attendre la libération du port 80 (vérification simple)
      logger.info("[ÉTAPE 6/11] Attente de la libération du port 80");
      let port80Free = false;
      for (let i = 0; i < 30; i++) {
        logger.debug(
          `[ÉTAPE 6/11] Vérification port 80 (tentative ${i + 1}/30)`
        );
        const portCheck = await executeHostCommand(
          `netstat -tuln | grep ':80 ' || echo 'free'`
        );
        if (
          portCheck.stdout.includes("free") ||
          !portCheck.stdout.includes(":80")
        ) {
          port80Free = true;
          logger.info("[ÉTAPE 6/11] Port 80 libéré");
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (!port80Free) {
        logger.warn(
          "[ÉTAPE 6/11] Le port 80 n'est pas libre, tentative de génération du certificat quand même"
        );
      }

      // Générer le certificat Let's Encrypt
      logger.info(
        "[ÉTAPE 6/11] Démarrage de certbot pour générer le certificat",
        {
          domain: app_domain,
          email: letsencrypt_email,
        }
      );

      const certbotStartTime = Date.now();

      // Ajouter un timeout global pour éviter que la fonction bloque indéfiniment
      logger.debug(
        "[ÉTAPE 6/11] Lancement de certbot avec timeout de 5 minutes"
      );
      const certbotPromise = executeHostCommand(
        `certbot certonly --standalone --non-interactive --agree-tos --email ${letsencrypt_email} -d ${app_domain}`,
        { timeout: 300000 } // 5 minutes pour certbot
      );

      // Timeout de sécurité supplémentaire (6 minutes pour laisser une marge)
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
        const certbotDuration = Date.now() - certbotStartTime;
        logger.info("[ÉTAPE 6/11] Certbot a terminé", {
          duration: `${certbotDuration}ms`,
          hasError: certbotResult.error,
          stdoutLength: certbotResult.stdout?.length || 0,
          stderrLength: certbotResult.stderr?.length || 0,
        });
      } catch (error) {
        const certbotDuration = Date.now() - certbotStartTime;
        const errorMsg = `Certbot n'a pas généré le certificat pour ${app_domain}: ${error.message}. Vérifiez DNS et port 80.`;
        logger.error("[ÉTAPE 6/11] Erreur certbot", {
          error: error.message,
          duration: `${certbotDuration}ms`,
        });
        await rollback(new Error(errorMsg));
        throw new Error(errorMsg);
      }

      // Vérifier les erreurs certbot (code de sortie non-zéro ou message d'erreur)
      if (
        certbotResult.error ||
        certbotResult.stderr.includes("error") ||
        certbotResult.stderr.includes("Error") ||
        certbotResult.stderr.includes("Failed") ||
        (!certbotResult.stdout.includes("Successfully") &&
          certbotResult.stderr.length > 0)
      ) {
        const errorMsg = `Certbot n'a pas généré le certificat pour ${app_domain}. Vérifiez DNS et port 80. Détails: ${
          certbotResult.stderr || certbotResult.stdout
        }`;
        logger.error("[ÉTAPE 6/11] Erreur certbot", {
          stdout: certbotResult.stdout,
          stderr: certbotResult.stderr,
          hasError: certbotResult.error,
        });
        await rollback(new Error(errorMsg));
        throw new Error(errorMsg);
      }

      logger.debug("Certbot a terminé avec succès", {
        stdout: certbotResult.stdout.substring(0, 500),
      });

      // Concaténer fullchain + privkey en PEM HAProxy
      logger.info("[ÉTAPE 6/11] Concaténation du certificat PEM");
      const concatResult = await executeHostCommand(
        `cat '${letsencrypt_live_dir}/${app_domain}/fullchain.pem' '${letsencrypt_live_dir}/${app_domain}/privkey.pem' > '${certPath}'`
      );

      if (concatResult.error) {
        const errorMsg = `Erreur lors de la création du certificat PEM: ${concatResult.stderr}`;
        logger.error(`[ÉTAPE 6/11] ${errorMsg}`);
        await rollback(new Error(errorMsg));
        throw new Error(errorMsg);
      }
      rollbackState.filesCreated.push(certPath);
      rollbackState.certCreated = true;
      logger.info("[ÉTAPE 6/11] Certificat PEM concaténé");

      // Définir les permissions du certificat
      logger.debug("[ÉTAPE 6/11] Définition des permissions du certificat");
      const chmodResult = await executeHostCommand(`chmod 600 '${certPath}'`);
      if (chmodResult.error) {
        const errorMsg = `Erreur lors de la définition des permissions du certificat: ${chmodResult.stderr}`;
        logger.error(`[ÉTAPE 6/11] ${errorMsg}`);
        await rollback(new Error(errorMsg));
        throw new Error(errorMsg);
      }
      logger.info("[ÉTAPE 6/11] Certificat généré avec succès");
    } else {
      // 7. Régénérer le PEM si le certificat Let's Encrypt existe mais le PEM est vide
      const letsencryptCertPath = `${letsencrypt_live_dir}/${app_domain}/fullchain.pem`;
      const letsencryptCertExists = await hostFileExists(letsencryptCertPath);

      if (letsencryptCertExists && (!certExists || certSize === 0)) {
        logger.debug("Régénération du PEM depuis Let's Encrypt");
        const regenResult = await executeHostCommand(
          `cat '${letsencrypt_live_dir}/${app_domain}/fullchain.pem' '${letsencrypt_live_dir}/${app_domain}/privkey.pem' > '${certPath}'`
        );
        if (regenResult.error) {
          const errorMsg = `Erreur lors de la régénération du certificat PEM: ${regenResult.stderr}`;
          logger.error(`[ÉTAPE 6/11] ${errorMsg}`);
          await rollback(new Error(errorMsg));
          throw new Error(errorMsg);
        }
        rollbackState.filesCreated.push(certPath);
        rollbackState.certCreated = true;

        const chmodResult = await executeHostCommand(`chmod 600 '${certPath}'`);
        if (chmodResult.error) {
          const errorMsg = `Erreur lors de la définition des permissions du certificat: ${chmodResult.stderr}`;
          logger.error(`[ÉTAPE 6/11] ${errorMsg}`);
          await rollback(new Error(errorMsg));
          throw new Error(errorMsg);
        }
      }
    }

    // 8. Créer le fichier ACL
    logger.info("[ÉTAPE 8/11] Création du fichier ACL");
    const aclContent = `# ==========================================
# ACL et routage pour ${app_name}
# ==========================================
    acl host_${app_slug} hdr(host) -i ${app_domain}
    use_backend ${app_slug}_backend if host_${app_slug}
`;
    const aclPath = `${haproxy_acl_dir}/${app_slug}.cfg`;
    // Utiliser printf pour éviter les problèmes d'échappement
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
      await rollback(new Error(errorMsg));
      throw new Error(errorMsg);
    }
    rollbackState.filesCreated.push(aclPath);
    logger.info("[ÉTAPE 8/11] Fichier ACL créé avec succès");

    // 9. Créer le fichier backend
    logger.info("[ÉTAPE 9/11] Création du fichier backend");
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
    // Utiliser printf pour éviter les problèmes d'échappement
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
      await rollback(new Error(errorMsg));
      throw new Error(errorMsg);
    }
    rollbackState.filesCreated.push(backendPath);
    logger.info("[ÉTAPE 9/11] Fichier backend créé avec succès");

    // 10. Vérifier les dates d'expiration du certificat
    logger.info(
      "[ÉTAPE 10/11] Vérification des dates d'expiration du certificat"
    );
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

    // 11. Redémarrer/recharger HAProxy
    logger.info("[ÉTAPE 11/11] Redémarrage/rechargement HAProxy");
    if (rollbackState.haproxyWasStopped) {
      // Si HAProxy a été arrêté pour certbot, le redémarrer
      logger.info("Redémarrage de HAProxy après génération du certificat");
      const startResult = await executeHostCommand(
        `systemctl start ${haproxy_service_name}`
      );
      if (startResult.error) {
        const errorMsg = `Erreur lors du redémarrage de HAProxy: ${startResult.stderr}`;
        logger.error(`[ÉTAPE 11/11] ${errorMsg}`);
        await rollback(new Error(errorMsg));
        throw new Error(errorMsg);
      }
      logger.info("[ÉTAPE 11/11] HAProxy redémarré avec succès");
    } else if (isHaproxyActive) {
      // Si HAProxy était actif et n'a pas été arrêté, recharger la configuration
      logger.info("Rechargement de la configuration HAProxy");
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
        // Si reload échoue, essayer restart
        const restartResult = await executeHostCommand(
          `systemctl restart ${haproxy_service_name}`
        );
        if (restartResult.error) {
          const errorMsg = `Erreur lors du redémarrage de HAProxy: ${restartResult.stderr}`;
          logger.error(`[ÉTAPE 11/11] ${errorMsg}`);
          await rollback(new Error(errorMsg));
          throw new Error(errorMsg);
        } else {
          logger.info("[ÉTAPE 11/11] HAProxy redémarré avec succès (restart)");
        }
      } else {
        logger.info(
          "[ÉTAPE 11/11] Configuration HAProxy rechargée avec succès"
        );
      }
    }

    const duration = Date.now() - startTime;
    logger.info("=== SUCCÈS addHaproxyApp ===", {
      app_name,
      app_domain,
      duration: `${duration}ms`,
    });

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

    // Le rollback a déjà été effectué dans les blocs catch individuels
    // Mais on le refait ici au cas où une erreur surviendrait ailleurs
    if (!rollbackState.rollbackExecuted) {
      rollbackState.rollbackExecuted = true;
      await rollback(error);
    }

    // Relancer l'erreur avec le message exact
    throw error;
  }
}
