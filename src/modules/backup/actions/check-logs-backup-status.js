/**
 * Action check-logs-backup-status - Vérifie si le backup des logs est activé
 *
 * @module modules/backup/actions/check-logs-backup-status
 */

import { logger } from "../../../shared/logger.js";
import { hostFileExists } from "./utils.js";
import { requireRole } from "../../../websocket/auth.js";

/**
 * Vérifie si le backup des logs est activé
 * @param {Object} params - Paramètres (non utilisés)
 * @param {Object} [callbacks] - Callbacks
 * @returns {Promise<Object>} État du backup
 */
export async function checkLogsBackupStatus(params = {}, callbacks = {}) {
  try {
    // Vérifier les permissions : seuls ADMIN et OWNER et EDITOR et USER peuvent vérifier l'état
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER", "EDITOR", "USER"],
      "vérifier l'état du backup des logs"
    );

    logger.debug("Vérification de l'état du backup des logs");

    // Le nom de fichier cron est généré à partir de "docker-logs-backup"
    // Format: agent-cron-docker-logs-backup
    const cronFileName = "agent-cron-docker-logs-backup";
    const cronFilePath = `/etc/cron.d/${cronFileName}`;

    // Vérifier si le fichier cron existe
    const cronFileExists = await hostFileExists(cronFilePath);

    // Vérifier aussi si le script Python existe
    const scriptPath = "/usr/local/bin/docker_log_collector_service.py";
    const scriptExists = await hostFileExists(scriptPath);

    // Vérifier si le fichier AWS existe
    const awsEnvFile = "/etc/._4d8f2.sh";
    const awsFileExists = await hostFileExists(awsEnvFile);

    const isEnabled = cronFileExists && scriptExists && awsFileExists;

    logger.info("État du backup des logs vérifié", {
      enabled: isEnabled,
      cronFileExists,
      scriptExists,
      awsFileExists,
    });

    return {
      success: true,
      enabled: isEnabled,
      cronFileExists,
      scriptExists,
      awsFileExists,
      cronFilePath: cronFileExists ? cronFilePath : null,
      scriptPath: scriptExists ? scriptPath : null,
      awsEnvFile: awsFileExists ? awsEnvFile : null,
    };
  } catch (error) {
    logger.error("Erreur lors de la vérification de l'état du backup des logs", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}
