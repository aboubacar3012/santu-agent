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
  try {
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

    // 1. Vérifier l'état initial de HAProxy
    logger.debug("Vérification de l'état de HAProxy");
    const haproxyStateResult = await executeHostCommand(
      `systemctl is-active ${haproxy_service_name} || echo 'inactive'`
    );
    const haproxyInitialState = haproxyStateResult.stdout.trim();
    const isHaproxyActive = haproxyInitialState === "active";
    logger.debug("État initial de HAProxy", { state: haproxyInitialState });

    // 2. Créer les répertoires nécessaires
    logger.debug("Création des répertoires nécessaires");
    for (const dir of [
      haproxy_certs_dir,
      haproxy_acl_dir,
      haproxy_backend_dir,
    ]) {
      const mkdirResult = await executeHostCommand(
        `mkdir -p '${dir}' && chmod 755 '${dir}'`
      );
      if (mkdirResult.error) {
        logger.warn(`Erreur lors de la création du répertoire ${dir}`, {
          error: mkdirResult.stderr,
        });
      }
    }

    // 3. Vérifier si le certificat existe déjà
    const certPath = `${haproxy_certs_dir}/${app_domain}.pem`;
    const certExists = await hostFileExists(certPath);
    const certSize = certExists ? await getHostFileSize(certPath) : 0;
    logger.debug("État du certificat", { exists: certExists, size: certSize });

    // 4. Supprimer un certificat vide ou corrompu
    if (certExists && certSize === 0) {
      logger.debug("Suppression du certificat vide");
      await executeHostCommand(`rm -f '${certPath}'`);
    }

    // 5. Supprimer l'ancien fichier legacy
    const legacyPath = `/etc/haproxy/conf.d/apps/${app_slug}.cfg`;
    const legacyExists = await hostFileExists(legacyPath);
    if (legacyExists) {
      logger.debug("Suppression de l'ancien fichier legacy");
      await executeHostCommand(`rm -f '${legacyPath}'`);
    }

    // 6. Générer le certificat si nécessaire
    const needsCert = !certExists || certSize === 0;
    let haproxyWasStopped = false;
    if (needsCert) {
      logger.info("Génération du certificat SSL nécessaire");

      // Arrêter HAProxy si actif
      if (isHaproxyActive) {
        logger.debug("Arrêt de HAProxy pour certbot");
        await executeHostCommand(`systemctl stop ${haproxy_service_name}`);
        haproxyWasStopped = true;
      }

      // Attendre la libération du port 80 (vérification simple)
      logger.debug("Attente de la libération du port 80");
      let port80Free = false;
      for (let i = 0; i < 30; i++) {
        const portCheck = await executeHostCommand(
          `netstat -tuln | grep ':80 ' || echo 'free'`
        );
        if (
          portCheck.stdout.includes("free") ||
          !portCheck.stdout.includes(":80")
        ) {
          port80Free = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (!port80Free) {
        logger.warn(
          "Le port 80 n'est pas libre, tentative de génération du certificat quand même"
        );
      }

      // Générer le certificat Let's Encrypt
      logger.info("Génération du certificat Let's Encrypt", {
        domain: app_domain,
      });
      const certbotResult = await executeHostCommand(
        `certbot certonly --standalone --non-interactive --agree-tos --email ${letsencrypt_email} -d ${app_domain}`,
        { timeout: 300000 } // 5 minutes pour certbot
      );

      if (certbotResult.error || certbotResult.stderr.includes("error")) {
        const errorMsg = `Certbot n'a pas généré le certificat pour ${app_domain}. Vérifiez DNS et port 80.`;
        logger.error(errorMsg, {
          stdout: certbotResult.stdout,
          stderr: certbotResult.stderr,
        });
        throw new Error(errorMsg);
      }

      // Concaténer fullchain + privkey en PEM HAProxy
      logger.debug("Concaténation du certificat PEM");
      const concatResult = await executeHostCommand(
        `cat '${letsencrypt_live_dir}/${app_domain}/fullchain.pem' '${letsencrypt_live_dir}/${app_domain}/privkey.pem' > '${certPath}'`
      );

      if (concatResult.error) {
        logger.error("Erreur lors de la concaténation du certificat", {
          error: concatResult.stderr,
        });
        throw new Error("Erreur lors de la création du certificat PEM");
      }

      // Définir les permissions du certificat
      await executeHostCommand(`chmod 600 '${certPath}'`);
      logger.info("Certificat généré avec succès");
    } else {
      // 7. Régénérer le PEM si le certificat Let's Encrypt existe mais le PEM est vide
      const letsencryptCertPath = `${letsencrypt_live_dir}/${app_domain}/fullchain.pem`;
      const letsencryptCertExists = await hostFileExists(letsencryptCertPath);

      if (letsencryptCertExists && (!certExists || certSize === 0)) {
        logger.debug("Régénération du PEM depuis Let's Encrypt");
        await executeHostCommand(
          `cat '${letsencrypt_live_dir}/${app_domain}/fullchain.pem' '${letsencrypt_live_dir}/${app_domain}/privkey.pem' > '${certPath}'`
        );
        await executeHostCommand(`chmod 600 '${certPath}'`);
      }
    }

    // 8. Créer le fichier ACL
    logger.debug("Création du fichier ACL");
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
      logger.error("Erreur lors de la création du fichier ACL", {
        error: aclResult.stderr,
      });
      throw new Error("Erreur lors de la création du fichier ACL");
    }

    // 9. Créer le fichier backend
    logger.debug("Création du fichier backend");
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
      logger.error("Erreur lors de la création du fichier backend", {
        error: backendResult.stderr,
      });
      throw new Error("Erreur lors de la création du fichier backend");
    }

    // 10. Vérifier les dates d'expiration du certificat
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

    logger.info("Configuration HAProxy déployée avec succès", {
      app_name,
      app_domain,
      app_slug,
    });

    // 11. Redémarrer/recharger HAProxy de manière asynchrone après la réponse
    // pour éviter de fermer la connexion WebSocket prématurément
    setImmediate(async () => {
      try {
        if (haproxyWasStopped) {
          // Si HAProxy a été arrêté pour certbot, le redémarrer
          logger.info("Redémarrage de HAProxy après génération du certificat");
          const startResult = await executeHostCommand(
            `systemctl start ${haproxy_service_name}`
          );
          if (startResult.error) {
            logger.error("Erreur lors du redémarrage de HAProxy", {
              error: startResult.stderr,
            });
          } else {
            logger.info("HAProxy redémarré avec succès");
          }
        } else if (isHaproxyActive) {
          // Si HAProxy était actif et n'a pas été arrêté, recharger la configuration
          logger.info("Rechargement de la configuration HAProxy");
          const reloadResult = await executeHostCommand(
            `systemctl reload ${haproxy_service_name}`
          );
          if (reloadResult.error) {
            logger.error("Erreur lors du rechargement de HAProxy", {
              error: reloadResult.stderr,
            });
            // Si reload échoue, essayer restart
            logger.info("Tentative de redémarrage complet de HAProxy");
            const restartResult = await executeHostCommand(
              `systemctl restart ${haproxy_service_name}`
            );
            if (restartResult.error) {
              logger.error("Erreur lors du redémarrage de HAProxy", {
                error: restartResult.stderr,
              });
            }
          } else {
            logger.info("Configuration HAProxy rechargée avec succès");
          }
        }
      } catch (error) {
        logger.error("Erreur lors du redémarrage/rechargement de HAProxy", {
          error: error.message,
        });
      }
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
    logger.error("Erreur lors de l'ajout de l'application HAProxy", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

