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
import { addCronJob } from "../../cron/actions/add-cron.js";
import { deleteCronJob } from "../../cron/actions/delete-cron.js";

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
    const {
      enabled,
      awsAccessKeyId,
      awsSecretAccessKey,
      awsRegion,
      awsLogsBucket,
    } = validatedParams;

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
        `printf '%s' '${escapedAwsEnv}' > '${awsEnvFile}' && chmod 600 '${awsEnvFile}' && chown root:root '${awsEnvFile}'`,
      );

      if (createAwsEnvResult.error) {
        throw new Error(
          `Erreur lors de la création du fichier AWS: ${createAwsEnvResult.stderr}`,
        );
      }

      // 2. Vérifier que Python3 est installé
      logger.info("Étape 2: Vérification de Python3");
      const pythonCheckResult = await executeHostCommand("which python3", {
        timeout: 5000,
      });

      if (pythonCheckResult.error || !pythonCheckResult.stdout.trim()) {
        throw new Error(
          "Python3 n'est pas installé. Veuillez installer Python3 d'abord.",
        );
      }

      // 3. Vérifier que boto3 et pytz sont installés
      logger.info("Étape 3: Vérification des dépendances Python");
      const boto3Check = await executeHostCommand(
        "python3 -c 'import boto3' 2>&1",
        { timeout: 5000 },
      );
      const pytzCheck = await executeHostCommand(
        "python3 -c 'import pytz' 2>&1",
        { timeout: 5000 },
      );

      if (boto3Check.error || pytzCheck.error) {
        logger.info("Installation des dépendances Python (boto3, pytz)...");

        // Vérifier que pip est disponible (essayer python3 -m pip d'abord, puis pip3)
        let pipCommand = null;

        // Essayer python3 -m pip d'abord (méthode recommandée)
        const pipModuleCheck = await executeHostCommand(
          "python3 -m pip --version 2>&1",
          { timeout: 5000 },
        );

        if (!pipModuleCheck.error && pipModuleCheck.stdout.trim()) {
          pipCommand = "python3 -m pip";
          logger.info("Utilisation de python3 -m pip");
        } else {
          // Essayer pip3
          const pip3Check = await executeHostCommand("pip3 --version 2>&1", {
            timeout: 5000,
          });

          if (!pip3Check.error && pip3Check.stdout.trim()) {
            pipCommand = "pip3";
            logger.info("Utilisation de pip3");
          } else {
            // pip n'est pas disponible, essayer de l'installer
            logger.info(
              "pip3 n'est pas disponible. Tentative d'installation de python3-pip...",
            );

            // Détecter le gestionnaire de paquets
            const aptCheck = await executeHostCommand("which apt-get 2>&1", {
              timeout: 5000,
            });
            const yumCheck = await executeHostCommand("which yum 2>&1", {
              timeout: 5000,
            });
            const dnfCheck = await executeHostCommand("which dnf 2>&1", {
              timeout: 5000,
            });

            let installPipCmd = null;
            if (!aptCheck.error) {
              installPipCmd =
                "apt-get update -y && apt-get install -y python3-pip";
            } else if (!dnfCheck.error) {
              installPipCmd = "dnf install -y python3-pip";
            } else if (!yumCheck.error) {
              installPipCmd = "yum install -y python3-pip";
            }

            if (installPipCmd) {
              logger.info(`Installation de python3-pip via: ${installPipCmd}`);
              const installPipResult = await executeHostCommand(
                `${installPipCmd} 2>&1`,
                { timeout: 120000 },
              );

              if (installPipResult.error) {
                logger.warn("Échec de l'installation de python3-pip", {
                  stderr: installPipResult.stderr,
                  stdout: installPipResult.stdout,
                });
              } else {
                logger.info("python3-pip installé avec succès");
                // Réessayer python3 -m pip
                const pipModuleCheck2 = await executeHostCommand(
                  "python3 -m pip --version 2>&1",
                  { timeout: 5000 },
                );
                if (!pipModuleCheck2.error) {
                  pipCommand = "python3 -m pip";
                }
              }
            }

            // Si pip n'est toujours pas disponible après tentative d'installation
            if (!pipCommand) {
              throw new Error(
                "pip3 n'est pas disponible et n'a pas pu être installé automatiquement. " +
                  "Veuillez installer python3-pip manuellement sur l'hôte: " +
                  "apt-get install python3-pip (Debian/Ubuntu) ou " +
                  "yum install python3-pip (CentOS/RHEL) ou " +
                  "dnf install python3-pip (Fedora)",
              );
            }
          }
        }

        // Installer les dépendances
        if (!pipCommand) {
          throw new Error("pip n'est pas disponible");
        }

        // Essayer d'abord via apt-get (plus propre pour les systèmes Debian/Ubuntu)
        logger.info(
          "Tentative d'installation via apt-get (python3-boto3, python3-pytz)...",
        );
        const aptCheck = await executeHostCommand("which apt-get 2>&1", {
          timeout: 5000,
        });

        let installedViaApt = false;
        if (!aptCheck.error) {
          const installAptResult = await executeHostCommand(
            "apt-get update -y >/dev/null 2>&1 && apt-get install -y python3-boto3 python3-pytz 2>&1",
            { timeout: 120000 },
          );

          if (!installAptResult.error) {
            // Vérifier que les modules sont maintenant disponibles
            const boto3CheckApt = await executeHostCommand(
              "python3 -c 'import boto3' 2>&1",
              { timeout: 5000 },
            );
            const pytzCheckApt = await executeHostCommand(
              "python3 -c 'import pytz' 2>&1",
              { timeout: 5000 },
            );

            if (!boto3CheckApt.error && !pytzCheckApt.error) {
              logger.info(
                "Dépendances Python installées via apt-get avec succès",
              );
              installedViaApt = true;
            }
          }
        }

        // Si apt-get a échoué ou n'est pas disponible, utiliser pip avec --break-system-packages
        if (!installedViaApt) {
          logger.info(
            `Exécution de: ${pipCommand} install --break-system-packages --upgrade boto3 pytz`,
          );
          const installPipResult = await executeHostCommand(
            `${pipCommand} install --break-system-packages --upgrade boto3 pytz 2>&1`,
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
      const scriptBase64 = Buffer.from(pythonScript, "utf-8").toString(
        "base64",
      );
      const escapedBase64 = escapeShellContent(scriptBase64);

      // Utiliser base64 -d (GNU) ou base64 --decode (BSD), avec fallback
      const deployScriptResult = await executeHostCommand(
        `echo '${escapedBase64}' | (base64 -d 2>/dev/null || base64 --decode 2>/dev/null) > '${scriptPath}' && chmod 755 '${scriptPath}' && chown root:root '${scriptPath}'`,
      );

      if (deployScriptResult.error) {
        throw new Error(
          `Erreur lors du déploiement du script: ${deployScriptResult.stderr}`,
        );
      }

      // 5. Créer la tâche cron (toutes les 2 minutes) via le module cron
      logger.info("Étape 5: Création de la tâche cron");
      const cronName = "docker-logs-backup";

      // Le script Python lit directement le fichier AWS via source et récupère automatiquement le hostname
      // Utiliser bash -c pour que source fonctionne (cron utilise /bin/sh par défaut)
      const cronCommand = `bash -c "source ${awsEnvFile} && python3 ${scriptPath}" >> /var/log/docker-log-collector.log 2>&1`;

      // Utiliser le module cron pour créer la tâche
      const cronResult = await addCronJob(
        {
          task_name: cronName,
          command: cronCommand,
          schedule: {
            minute: "*/2",
            hour: "*",
            day: "*",
            month: "*",
            weekday: "*",
          },
          user: "root",
          description: "Backup des logs Docker vers S3",
          enabled: true,
        },
        callbacks,
      );

      if (!cronResult.success) {
        throw new Error(
          `Erreur lors de la création de la tâche cron: ${cronResult.message || "Erreur inconnue"}`,
        );
      }

      const cronFile = cronResult.file_path;

      // 6. Créer le répertoire de logs
      logger.info("Étape 6: Création du répertoire de logs");
      await executeHostCommand(
        "mkdir -p /tmp/docker-logs && chmod 755 /tmp/docker-logs",
      );

      // 7. Test immédiat
      logger.info("Étape 7: Test immédiat du script");
      // Le script Python lit directement le fichier AWS via source et récupère automatiquement le hostname
      const testResult = await executeHostCommand(
        `bash -c "source ${awsEnvFile} && python3 ${scriptPath}"`,
        { timeout: 120000 },
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
      };
    } else {
      // ========== DÉSACTIVATION ==========

      logger.info("Désactivation du backup des logs");

      // 1. Supprimer la tâche cron via le module cron
      const cronName = "docker-logs-backup";

      try {
        const deleteCronResult = await deleteCronJob(
          {
            task_name: cronName,
          },
          callbacks,
        );

        if (deleteCronResult.success) {
          logger.info("Tâche cron supprimée");
        } else {
          logger.warn("Erreur lors de la suppression de la tâche cron", {
            message: deleteCronResult.message,
          });
        }
      } catch (error) {
        // Si la tâche n'existe pas, ce n'est pas grave
        if (error.message && error.message.includes("n'existe pas")) {
          logger.info("La tâche cron n'existe pas, rien à supprimer");
        } else {
          logger.warn("Erreur lors de la suppression de la tâche cron", {
            error: error.message,
          });
        }
      }

      // 2. Arrêter les processus en cours (optionnel)
      await executeHostCommand(
        "pkill -f docker_log_collector_service.py || true",
      );

      // Note: On garde le fichier AWS et le script Python pour permettre une réactivation rapide

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
