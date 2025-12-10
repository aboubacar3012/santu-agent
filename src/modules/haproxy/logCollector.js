/**
 * Collecteur de logs HAProxy en arrière-plan
 *
 * Ce module collecte continuellement les logs HAProxy et les stocke dans Redis,
 * même quand aucun client n'est connecté pour les lire.
 *
 * @module modules/haproxy/logCollector
 */

import { spawn } from "child_process";
import { logger } from "../../shared/logger.js";
import { storeLog, generateLogKey } from "../../shared/redis.js";

let logCollectorProcess = null;
let isCollecting = false;

/**
 * Vérifie si un log doit être ignoré (status 101)
 * @param {string} logLine - Ligne de log à vérifier
 * @returns {boolean} True si le log doit être ignoré
 */
function shouldIgnoreLog(logLine) {
  try {
    const jsonMatch = logLine.match(/\{.*\}/);
    if (!jsonMatch) {
      return false;
    }

    const logData = JSON.parse(jsonMatch[0]);
    if (logData && logData.response && logData.response.status === 101) {
      return true;
    }

    return false;
  } catch (error) {
    return false;
  }
}

/**
 * Démarre la collecte de logs HAProxy en arrière-plan
 * @returns {Promise<void>}
 */
export async function startLogCollector() {
  if (isCollecting) {
    logger.debug("Le collecteur de logs HAProxy est déjà en cours d'exécution");
    return;
  }

  try {
    logger.info("Démarrage du collecteur de logs HAProxy en arrière-plan");

    // Clé Redis pour les logs d'aujourd'hui
    const logKey = generateLogKey("haproxy:logs");

    // Commande pour suivre les logs HAProxy via journalctl
    const journalctlCommand = "journalctl -f -u haproxy --no-pager";
    const escapedCommand = journalctlCommand.replace(/'/g, "'\"'\"'");
    const nsenterCommand = `nsenter -t 1 -m -u -i -n -p -- sh -c '${escapedCommand}'`;

    // Démarrer le processus journalctl
    logCollectorProcess = spawn("sh", ["-c", nsenterCommand], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    isCollecting = true;
    let buffer = "";

    // Lire stdout ligne par ligne
    logCollectorProcess.stdout.on("data", async (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      // Garder la dernière ligne incomplète dans le buffer
      buffer = lines.pop() || "";

      // Traiter chaque ligne complète
      for (const line of lines) {
        if (line.trim() && !shouldIgnoreLog(line)) {
          // Stocker le log dans Redis (en arrière-plan, ne pas bloquer)
          storeLog(logKey, line).catch((error) => {
            // Erreurs de stockage Redis sont déjà loggées dans storeLog
            // On continue même en cas d'erreur Redis
          });
        }
      }
    });

    // Lire stderr pour les erreurs
    logCollectorProcess.stderr.on("data", (chunk) => {
      const errorLine = chunk.toString();
      logger.warn("Erreur journalctl dans le collecteur", { stderr: errorLine });
    });

    // Gérer les erreurs du processus
    logCollectorProcess.on("error", (error) => {
      logger.error("Erreur lors du démarrage du collecteur de logs", {
        error: error.message,
      });
      isCollecting = false;
      logCollectorProcess = null;
    });

    // Gérer la fermeture du processus
    logCollectorProcess.on("close", (code) => {
      logger.warn("Processus journalctl du collecteur fermé", {
        exitCode: code,
      });
      isCollecting = false;
      logCollectorProcess = null;

      // Tentative de redémarrage automatique après 5 secondes
      if (code !== 0) {
        logger.info("Tentative de redémarrage du collecteur dans 5 secondes...");
        setTimeout(() => {
          if (!isCollecting) {
            startLogCollector().catch((error) => {
              logger.error("Erreur lors du redémarrage du collecteur", {
                error: error.message,
              });
            });
          }
        }, 5000);
      }
    });

    logger.info("Collecteur de logs HAProxy démarré avec succès");
  } catch (error) {
    logger.error("Erreur lors du démarrage du collecteur de logs HAProxy", {
      error: error.message,
    });
    isCollecting = false;
    logCollectorProcess = null;
  }
}

/**
 * Arrête la collecte de logs HAProxy
 * @returns {Promise<void>}
 */
export async function stopLogCollector() {
  if (!isCollecting || !logCollectorProcess) {
    return;
  }

  try {
    logger.info("Arrêt du collecteur de logs HAProxy");

    if (logCollectorProcess && !logCollectorProcess.killed) {
      logCollectorProcess.kill("SIGTERM");

      // Forcer la fermeture après un délai si nécessaire
      setTimeout(() => {
        if (logCollectorProcess && !logCollectorProcess.killed) {
          logCollectorProcess.kill("SIGKILL");
        }
      }, 2000);
    }

    isCollecting = false;
    logCollectorProcess = null;

    logger.info("Collecteur de logs HAProxy arrêté");
  } catch (error) {
    logger.error("Erreur lors de l'arrêt du collecteur de logs", {
      error: error.message,
    });
  }
}

/**
 * Vérifie si le collecteur est actif
 * @returns {boolean} True si le collecteur est actif
 */
export function isCollectorActive() {
  return isCollecting && logCollectorProcess !== null;
}

