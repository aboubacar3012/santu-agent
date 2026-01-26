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

      // 2. Vérifier que Python3 est installé
      logger.info("Étape 2: Vérification de Python3");
      const pythonCheckResult = await executeHostCommand("which python3", {
        timeout: 5000,
      });

      if (pythonCheckResult.error || !pythonCheckResult.stdout.trim()) {
        throw new Error(
          "Python3 n'est pas installé. Veuillez installer Python3 d'abord."
        );
      }

      // 3. Vérifier que boto3 et pytz sont installés
      logger.info("Étape 3: Vérification des dépendances Python");
      const boto3Check = await executeHostCommand(
        "python3 -c 'import boto3' 2>&1",
        { timeout: 5000 }
      );
      const pytzCheck = await executeHostCommand(
        "python3 -c 'import pytz' 2>&1",
        { timeout: 5000 }
      );

      if (boto3Check.error || pytzCheck.error) {
        logger.info("Installation des dépendances Python (boto3, pytz)...");

        // Vérifier que pip est disponible (essayer python3 -m pip d'abord, puis pip3)
        const pipCheck = await executeHostCommand(
          "python3 -m pip --version 2>&1",
          { timeout: 5000 },
        );

        let pipCommand = "python3 -m pip";
        if (pipCheck.error) {
          const pip3Check = await executeHostCommand("pip3 --version 2>&1", {
            timeout: 5000,
          });
          if (pip3Check.error) {
            throw new Error(
              "pip3 n'est pas disponible. Veuillez installer pip3 d'abord (apt-get install python3-pip ou équivalent).",
            );
          }
          pipCommand = "pip3";
        }

        // Installer les dépendances (sans --quiet pour voir les erreurs)
        logger.info(`Exécution de: ${pipCommand} install --upgrade boto3 pytz`);
        const installPipResult = await executeHostCommand(
          `${pipCommand} install --upgrade boto3 pytz 2>&1`,
          { timeout: 300000 },
        );

        // Logger le résultat pour debug
        if (installPipResult.stdout) {
          logger.debug("Sortie de pip install", {
            stdout: installPipResult.stdout,
          });
        }
        if (installPipResult.stderr) {
          logger.debug("Erreur de pip install", {
            stderr: installPipResult.stderr,
          });
        }

        // Vérifier à nouveau après tentative d'installation (même si installPipResult.error)
        const boto3Check2 = await executeHostCommand(
          "python3 -c 'import boto3' 2>&1",
          { timeout: 5000 },
        );
        const pytzCheck2 = await executeHostCommand(
          "python3 -c 'import pytz' 2>&1",
          { timeout: 5000 },
        );

        if (boto3Check2.error || pytzCheck2.error) {
          const missing = [];
          if (boto3Check2.error) missing.push("boto3");
          if (pytzCheck2.error) missing.push("pytz");

          const errorMsg =
            installPipResult.stderr ||
            installPipResult.stdout ||
            "Commande échouée";
          logger.error("Échec de l'installation des dépendances Python", {
            missing,
            pipCommand,
            error: errorMsg,
            boto3Error: boto3Check2.stderr,
            pytzError: pytzCheck2.stderr,
          });

          throw new Error(
            `Échec de l'installation des dépendances Python. ${missing.join(" et ")} ${missing.length > 1 ? "sont" : "est"} requis. ` +
              `Erreur: ${errorMsg}. ` +
              `Veuillez installer manuellement sur l'hôte: ${pipCommand} install boto3 pytz`,
          );
        } else {
          logger.info("Dépendances Python installées avec succès");
        }
      } else {
        logger.info(
          "Les dépendances Python (boto3, pytz) sont déjà installées",
        );
      }

      // 4. Déployer le script Python
      logger.info("Étape 4: Déploiement du script Python");
      const scriptPath = "/usr/local/bin/docker_log_collector_service.py";
      const pythonScript = getPythonScript();
      
      // Encoder le script en base64 pour éviter les problèmes d'échappement
      const scriptBase64 = Buffer.from(pythonScript, "utf-8").toString("base64");
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

      // 5. Créer la tâche cron (toutes les 2 minutes)
      logger.info("Étape 5: Création de la tâche cron");
      const cronName = "docker-logs-backup";
      const cronFile = `/etc/cron.d/agent-cron-${cronName}`;
      // Le script Python lit directement le fichier AWS via source
      const cronCommand = `source ${awsEnvFile} && python3 ${scriptPath} --env ${env} >> /var/log/docker-log-collector.log 2>&1`;
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
      // Le script Python lit directement le fichier AWS via source
      const testResult = await executeHostCommand(
        `bash -c "source ${awsEnvFile} && python3 ${scriptPath} --env ${env}"`,
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
