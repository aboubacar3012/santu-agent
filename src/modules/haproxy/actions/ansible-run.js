/**
 * Action ansible-run - Installe et configure HAProxy en reproduisant le playbook Ansible
 *
 * @module modules/haproxy/actions/ansible-run
 */

import { logger } from "../../../shared/logger.js";
import { validateHaproxyParams } from "../validator.js";
import { executeHostCommand } from "./utils.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Lit un fichier d'erreur depuis le dossier errors
 * @param {string} filename - Nom du fichier
 * @returns {string} Contenu du fichier
 */
function readErrorFile(filename) {
  try {
    const filePath = join(__dirname, "errors", filename);
    return readFileSync(filePath, "utf-8");
  } catch (error) {
    logger.warn(`Impossible de lire le fichier d'erreur ${filename}`, {
      error: error.message,
    });
    return "";
  }
}

/**
 * Installe et configure HAProxy en reproduisant le playbook Ansible
 * @param {Object} params - Paramètres (non utilisés pour cette action)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Résultat de l'opération
 */
export async function runHaproxyAnsible(params = {}, callbacks = {}) {
  try {
    validateHaproxyParams("ansible-run", params);

    logger.info("Début de l'installation et configuration HAProxy");

    const haproxy_certs_dir = "/etc/haproxy/certs";
    const haproxy_conf_dir = "/etc/haproxy/conf.d";
    const haproxy_acl_dir = "/etc/haproxy/conf.d/acls";
    const haproxy_backend_dir = "/etc/haproxy/conf.d/backends";
    const haproxy_errors_dir = "/etc/haproxy/errors";
    const haproxy_service_name = "haproxy";
    const haproxy_config_file = "/etc/haproxy/haproxy.cfg";

    // ÉTAPE 1: Installation des packages
    logger.info("Étape 1: Installation des packages");
    const updateResult = await executeHostCommand(
      "apt-get update",
      { timeout: 300000 } // 5 minutes
    );
    if (updateResult.error) {
      logger.warn("Erreur lors de la mise à jour du cache", {
        stderr: updateResult.stderr,
      });
    }

    const installResult = await executeHostCommand(
      "apt-get install -y haproxy ssl-cert openssl certbot cron",
      { timeout: 600000 } // 10 minutes
    );
    if (installResult.error) {
      throw new Error(
        `Erreur lors de l'installation des packages: ${installResult.stderr}`
      );
    }

    // ÉTAPE 2: Création des répertoires
    logger.info("Étape 2: Création des répertoires");
    const dirs = [
      haproxy_certs_dir,
      haproxy_conf_dir,
      haproxy_acl_dir,
      haproxy_backend_dir,
      "/run/haproxy",
      haproxy_errors_dir,
    ];

    for (const dir of dirs) {
      const mkdirResult = await executeHostCommand(
        `mkdir -p '${dir}' && chmod 755 '${dir}'`
      );
      if (mkdirResult.error) {
        logger.warn(`Erreur lors de la création du répertoire ${dir}`, {
          stderr: mkdirResult.stderr,
        });
      }
    }

    // ÉTAPE 3: Sauvegarde de l'ancienne configuration
    logger.info("Étape 3: Sauvegarde de l'ancienne configuration");
    const oldConfigExists = await executeHostCommand(
      `test -f '${haproxy_config_file}' && echo 'exists' || echo 'not_exists'`
    );
    if (oldConfigExists.stdout.trim() === "exists") {
      const timestamp = Math.floor(Date.now() / 1000);
      const backupResult = await executeHostCommand(
        `cp '${haproxy_config_file}' '${haproxy_config_file}.backup.${timestamp}'`
      );
      if (backupResult.error) {
        logger.warn("Erreur lors de la sauvegarde", {
          stderr: backupResult.stderr,
        });
      } else {
        logger.info("Ancienne configuration sauvegardée");
      }
    }

    // Supprimer l'ancienne configuration
    await executeHostCommand(`rm -f '${haproxy_config_file}'`);

    // Supprimer les anciennes configurations modulaires
    await executeHostCommand(
      `rm -rf '${haproxy_conf_dir}/frontends' '${haproxy_conf_dir}/apps' '${haproxy_conf_dir}/frontend-web-in.cfg'`
    );

    // ÉTAPE 4: Déployer les pages d'erreur personnalisées
    logger.info("Étape 4: Déploiement des pages d'erreur");
    const errorFiles = [
      "400.http",
      "403.http",
      "408.http",
      "500.http",
      "502.http",
      "503.http",
      "504.http",
      "domain-not-found.http",
    ];

    for (const errorFile of errorFiles) {
      const content = readErrorFile(errorFile);
      if (content) {
        // Échapper le contenu pour l'utiliser dans une commande shell
        const escapedContent = content
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "'\"'\"'")
          .replace(/\$/g, "\\$")
          .replace(/`/g, "\\`");

        const writeResult = await executeHostCommand(
          `printf '%s' '${escapedContent}' > '${haproxy_errors_dir}/${errorFile}' && chmod 644 '${haproxy_errors_dir}/${errorFile}'`
        );
        if (writeResult.error) {
          logger.warn(`Erreur lors de l'écriture de ${errorFile}`, {
            stderr: writeResult.stderr,
          });
        } else {
          logger.debug(`Fichier d'erreur ${errorFile} déployé`);
        }
      }
    }

    // ÉTAPE 5: Génération de la configuration HAProxy modulaire
    logger.info("Étape 5: Génération de la configuration HAProxy");

    // Créer global.cfg
    const globalConfig = `# Configuration globale de HAProxy
# Ce bloc pose toutes les fondations (logs, sécurité, utilisateur système) partagées par toute la conf.
global
    # Journal principal : toutes les requêtes passent par syslog local0.
    log /dev/log local0
    # Journal secondaire pour les événements importants (notice).
    log /dev/log local1 notice
    # On enferme HAProxy dans /var/lib/haproxy pour réduire la surface d'attaque.
    chroot /var/lib/haproxy
    # Socket d'administration pour piloter HAProxy en live (stats, enable/disable, etc.).
    stats socket /run/haproxy/admin.sock mode 660 level admin expose-fd listeners
    # Timeout des commandes envoyées sur la socket stats.
    stats timeout 30s
    # Compte système utilisé pour exécuter le process.
    user haproxy
    # Groupe système associé.
    group haproxy
    # Mode daemon : tourne en arrière-plan et se détache du terminal.
    daemon

    # Default SSL material locations
    # Répertoires où l'on stocke les CA et les certificats serveur.
    ca-base /etc/ssl/certs
    crt-base /etc/ssl/private
    # Paramètre Diffie-Hellman utilisé lors des négociations TLS.
    tune.ssl.default-dh-param 2048

    # SECURE_MOD: Ciphers modernes et désactivation TLS 1.0/1.1
    # Liste stricte des suites autorisées pour respecter la politique sécurité interne.
    ssl-default-bind-ciphers TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:!aNULL:!MD5:!DSS:!RC4:!DES:!3DES:!SSLv3:!TLSv1:!TLSv1.1
    # Refus explicite des vieux protocoles SSLv3/TLS1.0/1.1.
    ssl-default-bind-options no-sslv3 no-tlsv10 no-tlsv11
`;

    const globalEscaped = globalConfig
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "'\"'\"'")
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");

    const globalResult = await executeHostCommand(
      `printf '%s' '${globalEscaped}' > '${haproxy_conf_dir}/global.cfg' && chmod 644 '${haproxy_conf_dir}/global.cfg'`
    );
    if (globalResult.error) {
      throw new Error(
        `Erreur lors de la création de global.cfg: ${globalResult.stderr}`
      );
    }

    // Créer defaults.cfg
    const defaultsConfig = `# Defaults : valeurs appliquées à tous les frontends/backends HTTP si on ne les surcharge pas.
defaults
    # Réutilise la configuration de logs définie dans le bloc global.
    log global
    # Tout parle HTTP par défaut (et non TCP brut).
    mode http
    # Pas de traces pour les connexions totalement vides (moins de bruit).
    option dontlognull
    # Format de log personnalisé
    # Format de log personnalisé - Version enrichie avec toutes les informations disponibles
    log-format "{\\\"timestamp\\\":\\\"%t\\\",\\\"client_ip\\\":\\\"%ci\\\",\\\"client_port\\\":%cp,\\\"method\\\":\\\"%HM\\\",\\\"path\\\":\\\"%HP\\\",\\\"query\\\":\\\"%HQ\\\",\\\"version\\\":\\\"%HV\\\",\\\"status\\\":%ST,\\\"bytes_read\\\":%B,\\\"bytes_uploaded\\\":%U,\\\"backend\\\":\\\"%b\\\",\\\"server\\\":\\\"%s\\\",\\\"server_queue\\\":%sq,\\\"backend_queue\\\":%bq,\\\"total_time_ms\\\":%Tt,\\\"connect_time_ms\\\":%Tc,\\\"response_time_ms\\\":%Tr,\\\"request_time_ms\\\":%Ta,\\\"ssl_version\\\":\\\"%sslv\\\",\\\"ssl_cipher\\\":\\\"%sslc\\\",\\\"user_agent\\\":\\\"%[capture.req.hdr(0)]\\\",\\\"host\\\":\\\"%[capture.req.hdr(1)]\\\",\\\"referer\\\":\\\"%[capture.req.hdr(2)]\\\",\\\"content_type\\\":\\\"%[capture.req.hdr(3)]\\\",\\\"content_length\\\":\\\"%[capture.req.hdr(4)]\\\",\\\"accept\\\":\\\"%[capture.req.hdr(5)]\\\",\\\"accept_language\\\":\\\"%[capture.req.hdr(6)]\\\",\\\"accept_encoding\\\":\\\"%[capture.req.hdr(7)]\\\",\\\"connection\\\":\\\"%[capture.req.hdr(8)]\\\",\\\"x_forwarded_for\\\":\\\"%[capture.req.hdr(9)]\\\",\\\"x_real_ip\\\":\\\"%[capture.req.hdr(10)]\\\"}"
    # Délai maxi pour se connecter à un serveur backend.
    timeout connect 30000ms
    # Délai maxi pour qu'un client reste branché.
    timeout client  2400s
    # Même chose côté serveur pour rester cohérent.
    timeout server  2400s
    # Fichiers d'erreurs personnalisés pour les principaux statuts HTTP.
    errorfile 400 /etc/haproxy/errors/400.http
    errorfile 403 /etc/haproxy/errors/403.http
    errorfile 408 /etc/haproxy/errors/408.http
    errorfile 500 /etc/haproxy/errors/500.http
    errorfile 502 /etc/haproxy/errors/502.http
    errorfile 503 /etc/haproxy/errors/503.http
    errorfile 504 /etc/haproxy/errors/504.http
`;

    // Échapper le contenu pour la commande shell
    // On utilise printf avec %b pour interpréter les séquences d'échappement
    // Dans la chaîne JavaScript, on a \\\" qui devient \" dans la chaîne réelle
    // Après échappement avec replace(/\\/g, "\\\\"), ça devient \\\" (deux backslashes + guillemet)
    // Avec printf '%b', \\\" sera interprété comme \" (backslash + guillemet), ce qui est correct
    const defaultsEscaped = defaultsConfig
      .replace(/\\/g, "\\\\") // Échapper tous les backslashes
      .replace(/'/g, "'\"'\"'") // Échapper les apostrophes pour la commande shell
      .replace(/\$/g, "\\$") // Échapper les $ pour éviter l'expansion de variables
      .replace(/`/g, "\\`"); // Échapper les backticks

    // Utiliser printf avec %b pour interpréter les séquences d'échappement (\n, \", etc.)
    // Cela permet de préserver correctement les backslashes pour les guillemets dans le format de log
    const defaultsResult = await executeHostCommand(
      `printf '%b' '${defaultsEscaped}' > '${haproxy_conf_dir}/defaults.cfg' && chmod 644 '${haproxy_conf_dir}/defaults.cfg'`
    );
    if (defaultsResult.error) {
      throw new Error(
        `Erreur lors de la création de defaults.cfg: ${defaultsResult.stderr}`
      );
    }

    // Créer frontend-web-in.cfg
    const frontendConfig = `# Frontend unifié pour gérer le trafic HTTP et HTTPS
# Porte d'entrée principale : écoute, applique les règles HTTP et achemine vers le bon backend.
frontend web-in
    log global
    # Bind HTTP et HTTPS sur le même frontend
    # Port 80 pour le trafic non chiffré (utile pour anciennes applis ou redirections automatiques).
    bind *:80
    # Port 443 pour le trafic chiffré avec nos certificats et ALPN HTTP/1.1.
    bind *:443 ssl crt /etc/haproxy/certs/ alpn http/1.1

    # On reste en mode HTTP et on trace finement les requêtes pour le support.
    mode http
    option http-server-close
    # Ajoute systématiquement X-Forwarded-For/X-Forwarded-Proto pour les backends.
    option forwardfor

    # Configuration des en-têtes IP du client
    # Ces headers donnent aux applis l'IP et le protocole réels de l'utilisateur final.
    http-request add-header X-Real-IP %[src]
    http-request set-header X-Forwarded-Proto http  if !{ ssl_fc }
    http-request set-header X-Forwarded-Proto https if  { ssl_fc }
    http-request set-header HTTPS off if !{ ssl_fc }
    http-request set-header HTTPS on  if  { ssl_fc }
    http-request set-header X-Client-IP %[src]
    http-request set-header X-Forwarded-For %[src]

    # SECURE_MOD: HSTS (Strict-Transport-Security)
    # Oblige les navigateurs à revenir en HTTPS pendant 2 ans (includeSubDomains + preload).
    http-response set-header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"

    # Les ACLs et use_backend sont définis dans les fichiers d'applications
    # Ces fichiers sont inclus après la définition des frontends dans haproxy.cfg
    default_backend default_error_backend
`;

    const frontendEscaped = frontendConfig
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "'\"'\"'")
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");

    const frontendResult = await executeHostCommand(
      `printf '%s' '${frontendEscaped}' > '${haproxy_conf_dir}/frontend-web-in.cfg' && chmod 644 '${haproxy_conf_dir}/frontend-web-in.cfg'`
    );
    if (frontendResult.error) {
      throw new Error(
        `Erreur lors de la création de frontend-web-in.cfg: ${frontendResult.stderr}`
      );
    }

    // Créer default-backend.cfg
    const defaultBackendConfig = `# Backend par défaut pour les domaines non configurés
backend default_error_backend
    mode http
    errorfile 503 /etc/haproxy/errors/domain-not-found.http
`;

    const defaultBackendEscaped = defaultBackendConfig
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "'\"'\"'")
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");

    const defaultBackendResult = await executeHostCommand(
      `printf '%s' '${defaultBackendEscaped}' > '${haproxy_backend_dir}/default-backend.cfg' && chmod 644 '${haproxy_backend_dir}/default-backend.cfg'`
    );
    if (defaultBackendResult.error) {
      throw new Error(
        `Erreur lors de la création de default-backend.cfg: ${defaultBackendResult.stderr}`
      );
    }

    // Assembler la configuration complète
    logger.info("Assemblage de la configuration complète");
    // Utiliser une approche plus simple avec des commandes séquentielles
    const assembleCommands = [
      `cat '${haproxy_conf_dir}/global.cfg' '${haproxy_conf_dir}/defaults.cfg' > '${haproxy_config_file}'`,
      `[ -f '${haproxy_conf_dir}/frontend-web-in.cfg' ] && cat '${haproxy_conf_dir}/frontend-web-in.cfg' >> '${haproxy_config_file}' || true`,
      `ls '${haproxy_acl_dir}'/*.cfg >/dev/null 2>&1 && cat '${haproxy_acl_dir}'/*.cfg >> '${haproxy_config_file}' || true`,
      `ls '${haproxy_backend_dir}'/*.cfg >/dev/null 2>&1 && for f in '${haproxy_backend_dir}'/*.cfg; do [ "\$(basename "\$f")" != "default-backend.cfg" ] && cat "\$f" >> '${haproxy_config_file}' || true; done || true`,
      `[ -f '${haproxy_backend_dir}/default-backend.cfg' ] && cat '${haproxy_backend_dir}/default-backend.cfg' >> '${haproxy_config_file}' || true`,
    ];

    // La première commande est critique (création du fichier de base)
    const firstCommand = assembleCommands[0];
    const firstResult = await executeHostCommand(firstCommand);
    if (firstResult.error) {
      throw new Error(
        `Erreur lors de l'assemblage de la configuration: ${firstResult.stderr}`
      );
    }

    // Les autres commandes sont optionnelles (elles ont || true)
    for (let i = 1; i < assembleCommands.length; i++) {
      const cmd = assembleCommands[i];
      const assembleResult = await executeHostCommand(cmd);
      if (assembleResult.error) {
        logger.warn("Erreur lors de l'assemblage (non bloquant)", {
          command: cmd,
          stderr: assembleResult.stderr,
        });
      }
    }

    // ÉTAPE 6: Vérification de la syntaxe
    logger.info("Étape 6: Vérification de la syntaxe");
    const syntaxCheckResult = await executeHostCommand(
      `haproxy -c -f ${haproxy_config_file}`
    );
    if (syntaxCheckResult.error) {
      throw new Error(
        `Erreur de syntaxe dans la configuration HAProxy: ${syntaxCheckResult.stderr}`
      );
    }

    // ÉTAPE 7: Activation et démarrage du service
    logger.info("Étape 7: Activation et démarrage du service");
    const enableResult = await executeHostCommand(
      `systemctl enable ${haproxy_service_name}`
    );
    if (enableResult.error) {
      logger.warn("Erreur lors de l'activation du service", {
        stderr: enableResult.stderr,
      });
    }

    const statusResult = await executeHostCommand(
      `systemctl is-active ${haproxy_service_name} || echo 'inactive'`
    );
    const isActive = statusResult.stdout.trim() === "active";

    if (isActive) {
      // Recharger la configuration
      logger.info("Rechargement de la configuration HAProxy");
      const reloadResult = await executeHostCommand(
        `systemctl reload ${haproxy_service_name}`
      );
      if (reloadResult.error) {
        logger.warn("Erreur lors du rechargement, tentative de redémarrage", {
          stderr: reloadResult.stderr,
        });
        const restartResult = await executeHostCommand(
          `systemctl restart ${haproxy_service_name}`
        );
        if (restartResult.error) {
          throw new Error(
            `Erreur lors du redémarrage de HAProxy: ${restartResult.stderr}`
          );
        }
      }
    } else {
      // Démarrer le service
      logger.info("Démarrage du service HAProxy");
      const startResult = await executeHostCommand(
        `systemctl start ${haproxy_service_name}`
      );
      if (startResult.error) {
        throw new Error(
          `Erreur lors du démarrage de HAProxy: ${startResult.stderr}`
        );
      }
    }

    // Attendre que le service soit prêt
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Vérifier le statut final
    const finalStatusResult = await executeHostCommand(
      `systemctl status ${haproxy_service_name} --no-pager -l || true`
    );

    const versionResult = await executeHostCommand(`haproxy -v || true`);

    logger.info("Installation et configuration HAProxy terminées avec succès");

    return {
      success: true,
      message: "Installation et configuration HAProxy terminées avec succès",
      status: finalStatusResult.stdout || "",
      version: versionResult.stdout || "",
    };
  } catch (error) {
    logger.error("Erreur lors de l'installation et configuration HAProxy", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}
