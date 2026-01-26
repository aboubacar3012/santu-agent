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
 * Lit le script Python depuis le fichier local
 * @returns {string} Contenu du script Python
 */
function getPythonScript() {
  try {
    const scriptPath = join(__dirname, "docker_log_collector_service.py");
    return readFileSync(scriptPath, "utf-8");
  } catch (error) {
    logger.error("Impossible de lire le script Python", {
      error: error.message,
    });
    throw new Error("Script Python introuvable");
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

      // 2. Installer python3-venv si nécessaire
      logger.info("Étape 2: Installation des dépendances Python");
      const installVenvResult = await executeHostCommand(
        "apt-get update && apt-get install -y python3-venv",
        { timeout: 300000 }
      );

      if (installVenvResult.error) {
        logger.warn("Erreur lors de l'installation de python3-venv", {
          stderr: installVenvResult.stderr,
        });
      }

      // 3. Créer l'environnement virtuel
      logger.info("Étape 3: Création de l'environnement virtuel");
      const venvDir = "/opt/docker-log-collector/venv";
      const venvExists = await hostDirExists(venvDir);

      if (!venvExists) {
        const createVenvResult = await executeHostCommand(
          `python3 -m venv '${venvDir}'`,
          { timeout: 60000 }
        );

        if (createVenvResult.error) {
          throw new Error(
            `Erreur lors de la création du venv: ${createVenvResult.stderr}`
          );
        }
      }

      // 4. Mettre à jour pip
      logger.info("Étape 4: Mise à jour de pip");
      const updatePipResult = await executeHostCommand(
        `${venvDir}/bin/pip install --upgrade pip`,
        { timeout: 60000 }
      );

      if (updatePipResult.error) {
        logger.warn("Erreur lors de la mise à jour de pip", {
          stderr: updatePipResult.stderr,
        });
      }

      // 5. Installer les dépendances Python
      logger.info("Étape 5: Installation des dépendances Python");
      const installDepsResult = await executeHostCommand(
        `${venvDir}/bin/pip install 'boto3>=1.26.0' 'botocore>=1.29.0' 'pytz>=2023.3'`,
        { timeout: 300000 }
      );

      if (installDepsResult.error) {
        throw new Error(
          `Erreur lors de l'installation des dépendances: ${installDepsResult.stderr}`
        );
      }

      // 6. Déployer le script Python
      logger.info("Étape 6: Déploiement du script Python");
      const scriptPath = "/usr/local/bin/docker_log_collector_service.py";
      const pythonScript = getPythonScript();
      const escapedScript = escapeShellContent(pythonScript);

      const deployScriptResult = await executeHostCommand(
        `printf '%s' '${escapedScript}' > '${scriptPath}' && chmod 755 '${scriptPath}' && chown root:root '${scriptPath}'`
      );

      if (deployScriptResult.error) {
        throw new Error(
          `Erreur lors du déploiement du script: ${deployScriptResult.stderr}`
        );
      }

      // 7. Créer la tâche cron (toutes les 2 minutes)
      logger.info("Étape 7: Création de la tâche cron");
      const cronName = "docker-logs-backup";
      const cronFile = `/etc/cron.d/agent-cron-${cronName}`;
      const cronCommand = `source ${awsEnvFile} && ${venvDir}/bin/python ${scriptPath} --env ${env} >> /var/log/docker-log-collector.log 2>&1`;
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

      // 8. Créer le répertoire de logs
      logger.info("Étape 8: Création du répertoire de logs");
      await executeHostCommand(
        "mkdir -p /tmp/docker-logs && chmod 755 /tmp/docker-logs"
      );

      // 9. Test immédiat
      logger.info("Étape 9: Test immédiat du script");
      const testResult = await executeHostCommand(
        `source ${awsEnvFile} && ${venvDir}/bin/python ${scriptPath} --env ${env}`,
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
        "pkill -f docker_log_collector_service.py || true"
      );

      // Note: On garde le fichier AWS, le script Python et le venv pour permettre une réactivation rapide

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
