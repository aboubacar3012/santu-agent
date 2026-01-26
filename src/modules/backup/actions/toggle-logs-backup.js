/**
 * Action toggle-logs-backup - Active ou désactive le backup des logs Docker vers S3
 *
 * @module modules/backup/actions/toggle-logs-backup
 */

import { logger } from "../../../shared/logger.js";
import { validateBackupParams } from "../validator.js";
import { executeHostCommand, hostFileExists, hostDirExists } from "./utils.js";
import { requireRole } from "../../../websocket/auth.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Échappe le contenu pour l'utiliser dans une commande shell
 * @param {string} content - Contenu à échapper
 * @returns {string} Contenu échappé
 */
function escapeShellContent(content) {
  return content
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "'\"'\"'")
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

/**
 * Lit le script JavaScript depuis le fichier local
 * @returns {string} Contenu du script JavaScript
 */
function getJavaScriptScript() {
  try {
    const scriptPath = join(__dirname, "docker_log_collector_service.js");
    return readFileSync(scriptPath, "utf-8");
  } catch (error) {
    logger.error("Impossible de lire le script JavaScript", {
      error: error.message,
    });
    throw new Error("Script JavaScript introuvable");
  }
}

/**
 * Active ou désactive le backup des logs Docker vers S3
 * @param {Object} params - Paramètres
 * @param {boolean} params.enabled - Activer ou désactiver
 * @param {string} [params.awsAccessKeyId] - AWS Access Key ID (requis si enabled)
 * @param {string} [params.awsSecretAccessKey] - AWS Secret Access Key (requis si enabled)
 * @param {string} [params.awsRegion] - AWS Region (requis si enabled)
 * @param {string} [params.awsLogsBucket] - AWS S3 Bucket pour les logs (requis si enabled)
 * @param {string} [params.env] - Environnement (dev, sandbox, prod) - défaut: prod
 * @param {Object} [callbacks] - Callbacks
 * @returns {Promise<Object>} Résultat de l'opération
 */
export async function toggleLogsBackup(params = {}, callbacks = {}) {
  try {
    // Vérifier les permissions
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER", "EDITOR"],
      "gérer les backups"
    );

    // Valider les paramètres
    const validatedParams = validateBackupParams("toggle-logs-backup", params);
    const { enabled, awsAccessKeyId, awsSecretAccessKey, awsRegion, awsLogsBucket, env } =
      validatedParams;

    logger.info(
      enabled ? "Activation du backup des logs" : "Désactivation du backup des logs"
    );

    if (enabled) {
      // ========== ACTIVATION ==========

      // 1. Créer le fichier d'environnement AWS
      logger.info("Étape 1: Création du fichier d'environnement AWS");
      const awsEnvFile = "/etc/._4d8f2.sh";
      const awsEnvContent = `export AWS_ACCESS_KEY_ID="${awsAccessKeyId}"
export AWS_SECRET_ACCESS_KEY="${awsSecretAccessKey}"
export AWS_REGION="${awsRegion}"
export AWS_LOGS_BUCKET="${awsLogsBucket}"
`;

      const escapedAwsEnv = escapeShellContent(awsEnvContent);
      const createAwsEnvResult = await executeHostCommand(
        `printf '%s' '${escapedAwsEnv}' > '${awsEnvFile}' && chmod 600 '${awsEnvFile}' && chown root:root '${awsEnvFile}'`
      );

      if (createAwsEnvResult.error) {
        throw new Error(
          `Erreur lors de la création du fichier AWS: ${createAwsEnvResult.stderr}`
        );
      }

      // 2. Vérifier que Node.js est installé
      logger.info("Étape 2: Vérification de Node.js");
      const nodeCheckResult = await executeHostCommand("which node", {
        timeout: 5000,
      });

      if (nodeCheckResult.error || !nodeCheckResult.stdout.trim()) {
        throw new Error(
          "Node.js n'est pas installé. Veuillez installer Node.js d'abord."
        );
      }

      // 3. Déployer le script JavaScript
      logger.info("Étape 3: Déploiement du script JavaScript");
      const scriptPath = "/usr/local/bin/docker_log_collector_service.js";
      const jsScript = getJavaScriptScript();
      
      // Encoder le script en base64 pour éviter les problèmes d'échappement
      // base64 est disponible sur tous les systèmes Linux modernes
      const scriptBase64 = Buffer.from(jsScript, "utf-8").toString("base64");
      const escapedBase64 = escapeShellContent(scriptBase64);

      // Utiliser base64 -d (GNU) ou base64 --decode (BSD), avec fallback
      const deployScriptResult = await executeHostCommand(
        `echo '${escapedBase64}' | (base64 -d 2>/dev/null || base64 --decode 2>/dev/null) > '${scriptPath}' && chmod 755 '${scriptPath}' && chown root:root '${scriptPath}'`
      );

      if (deployScriptResult.error) {
        throw new Error(
          `Erreur lors du déploiement du script: ${deployScriptResult.stderr}`
        );
      }

      // 4. Vérifier/Installer les dépendances npm si nécessaire (pour @aws-sdk/client-s3)
      logger.info("Étape 4: Vérification des dépendances npm");
      const npmDir = "/opt/docker-log-collector";
      
      // Vérifier d'abord si le module est déjà installé localement
      const checkLocalModule = await executeHostCommand(
        `test -d '${npmDir}/node_modules/@aws-sdk/client-s3' && echo 'exists' || echo 'not_exists'`
      );

      // Vérifier aussi dans les node_modules globaux (si npm global prefix existe)
      const checkGlobalPrefix = await executeHostCommand(
        `npm config get prefix 2>/dev/null || echo ''`
      );
      let checkGlobalModule = { stdout: "not_exists" };
      if (checkGlobalPrefix.stdout.trim()) {
        const globalNodeModules = `${checkGlobalPrefix.stdout.trim()}/lib/node_modules/@aws-sdk/client-s3`;
        checkGlobalModule = await executeHostCommand(
          `test -d '${globalNodeModules}' && echo 'exists' || echo 'not_exists'`
        );
      }

      const moduleExists = 
        checkLocalModule.stdout.trim() === "exists" || 
        checkGlobalModule.stdout.trim() === "exists";

      if (moduleExists) {
        logger.info("Le module @aws-sdk/client-s3 est déjà disponible");
        // S'assurer que le répertoire existe pour NODE_PATH
        await executeHostCommand(`mkdir -p '${npmDir}'`, { timeout: 5000 });
      } else {
        // Le module n'existe pas, l'installer
        logger.info("Installation de @aws-sdk/client-s3...");
        await executeHostCommand(`mkdir -p '${npmDir}'`, { timeout: 5000 });
        
        // Créer un package.json minimal pour installer @aws-sdk/client-s3
        const packageJson = JSON.stringify({
          name: "docker-log-collector",
          version: "1.0.0",
          type: "module",
          dependencies: {
            "@aws-sdk/client-s3": "^3.975.0",
          },
        });
        const escapedPackageJson = escapeShellContent(packageJson);
        const createPackageJsonResult = await executeHostCommand(
          `printf '%s' '${escapedPackageJson}' > '${npmDir}/package.json'`
        );

        if (createPackageJsonResult.error) {
          throw new Error(
            `Erreur lors de la création du package.json: ${createPackageJsonResult.stderr}`
          );
        }

        // Vérifier que npm est disponible
        const npmCheckResult = await executeHostCommand("which npm", {
          timeout: 5000,
        });

        if (npmCheckResult.error || !npmCheckResult.stdout.trim()) {
          throw new Error(
            "npm n'est pas installé. Veuillez installer Node.js et npm d'abord."
          );
        }

        // Installer les dépendances (via nsenter, donc sur l'hôte)
        const installNpmResult = await executeHostCommand(
          `cd '${npmDir}' && npm install --production --no-save --loglevel=error`,
          { timeout: 300000 }
        );

        if (installNpmResult.error) {
          logger.error("Erreur lors de l'installation des dépendances npm", {
            stderr: installNpmResult.stderr,
            stdout: installNpmResult.stdout,
          });
          throw new Error(
            `Échec de l'installation des dépendances npm: ${installNpmResult.stderr}`
          );
        }

        // Vérifier que le module est bien installé
        const moduleCheckResult = await executeHostCommand(
          `test -d '${npmDir}/node_modules/@aws-sdk/client-s3' && echo 'exists' || echo 'not_exists'`
        );

        if (moduleCheckResult.stdout.trim() !== "exists") {
          throw new Error(
            `Le module @aws-sdk/client-s3 n'a pas été installé correctement dans ${npmDir}/node_modules`
          );
        }

        logger.info("Dépendances npm installées avec succès");
      }

      // 5. Créer la tâche cron (toutes les 2 minutes)
      logger.info("Étape 5: Création de la tâche cron");
      const cronName = "docker-logs-backup";
      const cronFile = `/etc/cron.d/agent-cron-${cronName}`;
      // Le script Node.js lit directement le fichier AWS, pas besoin de source
      // Utiliser bash explicitement pour garantir que export fonctionne
      const cronCommand = `bash -c "export NODE_PATH='${npmDir}/node_modules' && node ${scriptPath} --env ${env}" >> /var/log/docker-log-collector.log 2>&1`;
      const cronLine = `*/2 * * * * root ${cronCommand}\n`;

      const escapedCron = escapeShellContent(cronLine);
      const createCronResult = await executeHostCommand(
        `printf '%s' '${escapedCron}' > '${cronFile}' && chmod 644 '${cronFile}' && chown root:root '${cronFile}'`
      );

      if (createCronResult.error) {
        throw new Error(
          `Erreur lors de la création de la tâche cron: ${createCronResult.stderr}`
        );
      }

      // 6. Créer le répertoire de logs
      logger.info("Étape 6: Création du répertoire de logs");
      await executeHostCommand(
        "mkdir -p /tmp/docker-logs && chmod 755 /tmp/docker-logs"
      );

      // 7. Test immédiat
      logger.info("Étape 7: Test immédiat du script");
      // Le script Node.js lit directement le fichier AWS, pas besoin de source
      // Utiliser bash pour garantir que export fonctionne correctement
      const testResult = await executeHostCommand(
        `bash -c "export NODE_PATH='${npmDir}/node_modules' && node ${scriptPath} --env ${env}"`,
        { timeout: 120000 }
      );

      if (testResult.error) {
        logger.warn("Erreur lors du test immédiat", {
          stderr: testResult.stderr,
        });
      } else {
        logger.info("Test immédiat réussi", {
          stdout: testResult.stdout,
        });
      }

      return {
        success: true,
        enabled: true,
        message: "Backup des logs activé avec succès",
        awsEnvFile,
        scriptPath,
        cronFile,
        env,
      };
    } else {
      // ========== DÉSACTIVATION ==========

      logger.info("Désactivation du backup des logs");

      // 1. Supprimer la tâche cron
      const cronName = "docker-logs-backup";
      const cronFile = `/etc/cron.d/agent-cron-${cronName}`;
      const cronExists = await hostFileExists(cronFile);

      if (cronExists) {
        const deleteCronResult = await executeHostCommand(`rm -f '${cronFile}'`);
        if (deleteCronResult.error) {
          logger.warn("Erreur lors de la suppression de la tâche cron", {
            stderr: deleteCronResult.stderr,
          });
        } else {
          logger.info("Tâche cron supprimée");
        }
      }

      // 2. Arrêter les processus en cours (optionnel)
      await executeHostCommand(
        "pkill -f docker_log_collector_service.js || true"
      );

      // Note: On garde le fichier AWS et le script JavaScript pour permettre une réactivation rapide

      return {
        success: true,
        enabled: false,
        message: "Backup des logs désactivé avec succès",
      };
    }
  } catch (error) {
    logger.error("Erreur lors de la gestion du backup des logs", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}
