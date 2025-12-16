/**
 * Action logs - Récupère les logs HAProxy en temps réel
 *
 * @module modules/haproxy/actions/logs
 */

import { spawn } from "child_process";
import { logger } from "../../../shared/logger.js";
import { validateHaproxyParams } from "../validator.js";
import {
  storeLog,
  getCachedLogsLast24h,
  generateLogKey,
} from "../../../shared/redis.js";
import { requireRole } from "../../../websocket/auth.js";

/**
 * Parse une ligne de log HAProxy et vérifie si elle doit être filtrée
 * @param {string} logLine - Ligne de log à parser
 * @returns {boolean} True si le log doit être ignoré (status 101)
 */
function shouldIgnoreLog(logLine) {
  try {
    // Extraire le JSON du log (format: "Dec 05 14:44:01 haproxy[123]: { ... }")
    const jsonMatch = logLine.match(/\{.*\}/);
    if (!jsonMatch) {
      return false; // Si pas de JSON, on ne filtre pas
    }

    const logData = JSON.parse(jsonMatch[0]);

    // Vérifier si le status code est 101 (changement de protocole)
    if (logData && logData.response && logData.response.status === 101) {
      return true; // Ignorer ce log
    }

    return false; // Ne pas ignorer
  } catch (error) {
    // En cas d'erreur de parsing, on ne filtre pas (on laisse passer)
    logger.debug("Erreur lors du parsing d'un log pour filtrage", {
      error: error.message,
    });
    return false;
  }
}

/**
 * Récupère les logs HAProxy en temps réel via journalctl
 * @param {Object} params - Paramètres (non utilisés pour le moment)
 * @param {Object} callbacks - Callbacks pour le streaming
 * @param {Function} callbacks.onStream - Callback pour les données de stream
 * @returns {Promise<Object>} Informations de stream
 */
export async function getHaproxyLogs(params = {}, callbacks = {}) {
  try {
    // Vérifier les permissions : ADMIN, OWNER, EDITOR et USER peuvent consulter les logs HAProxy
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER", "EDITOR", "USER"],
      "consulter les logs HAProxy"
    );

    validateHaproxyParams("logs", params);

    // Mode streaming uniquement
    if (!callbacks.onStream) {
      throw new Error(
        "onStream callback est requis pour le streaming des logs"
      );
    }

    logger.debug("Début du streaming des logs HAProxy en temps réel");

    // Clé Redis pour les logs d'aujourd'hui
    const logKey = generateLogKey("haproxy:logs");

    // ÉTAPE 1 : Récupérer et envoyer les logs en cache des dernières 24h avant de commencer le streaming
    try {
      const cachedLogs = await getCachedLogsLast24h("haproxy:logs", 5000);
      if (cachedLogs.length > 0) {
        logger.debug(`Envoi de ${cachedLogs.length} logs en cache (24h)`, {
          prefix: "haproxy:logs",
        });

        // Envoyer les logs en cache (du plus ancien au plus récent)
        // Les logs sont déjà triés par timestamp dans getCachedLogsLast24h
        for (const cachedLog of cachedLogs) {
          if (
            cachedLog.log &&
            cachedLog.log.trim() &&
            !shouldIgnoreLog(cachedLog.log)
          ) {
            callbacks.onStream("stdout", cachedLog.log + "\n");
          }
        }

        logger.debug(
          "Logs en cache envoyés, démarrage du streaming en temps réel"
        );
      } else {
        logger.debug(
          "Aucun log en cache trouvé, démarrage direct du streaming"
        );
      }
    } catch (error) {
      logger.warn("Erreur lors de la récupération des logs en cache", {
        error: error.message,
      });
      // Continuer même si le cache échoue
    }

    // ÉTAPE 2 : Démarrer le streaming en temps réel
    // Commande pour suivre les logs HAProxy via journalctl
    // Utiliser nsenter pour exécuter sur l'hôte depuis le conteneur
    const journalctlCommand = "journalctl -f -u haproxy --no-pager";
    const escapedCommand = journalctlCommand.replace(/'/g, "'\"'\"'");
    const nsenterCommand = `nsenter -t 1 -m -u -i -n -p -- sh -c '${escapedCommand}'`;

    // Démarrer le processus journalctl avec spawn pour le streaming
    const journalctlProcess = spawn("sh", ["-c", nsenterCommand], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";

    // Lire stdout ligne par ligne
    journalctlProcess.stdout.on("data", async (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      // Garder la dernière ligne incomplète dans le buffer
      buffer = lines.pop() || "";

      // Traiter chaque ligne complète
      for (const line of lines) {
        if (line.trim() && !shouldIgnoreLog(line)) {
          // Envoyer le log via le callback
          callbacks.onStream("stdout", line + "\n");

          // Ne PAS stocker le log dans Redis ici car le collecteur en arrière-plan le fait déjà
          // Cela évite les doublons et améliore les performances
          // Le collecteur stocke tous les logs de manière continue, même sans client connecté
        }
      }
    });

    // Lire stderr pour les erreurs
    journalctlProcess.stderr.on("data", (chunk) => {
      const errorLine = chunk.toString();
      logger.warn("Erreur journalctl", { stderr: errorLine });
      callbacks.onStream("stderr", errorLine);
    });

    // Gérer les erreurs du processus
    journalctlProcess.on("error", (error) => {
      logger.error("Erreur lors du démarrage de journalctl", {
        error: error.message,
      });
      callbacks.onStream("stderr", `Erreur: ${error.message}\n`);
    });

    // Gérer la fermeture du processus
    journalctlProcess.on("close", (code) => {
      logger.debug("Processus journalctl fermé", { exitCode: code });
      // Envoyer la dernière ligne du buffer si elle existe
      if (buffer.trim()) {
        callbacks.onStream("stdout", buffer + "\n");
      }
    });

    return {
      isStreaming: true,
      initialResponse: {
        stream: "stdout",
        mode: "haproxy.logs",
      },
      resource: {
        type: "haproxy-logs",
        cleanup: () => {
          logger.debug("Nettoyage du processus journalctl");
          if (journalctlProcess && !journalctlProcess.killed) {
            try {
              journalctlProcess.kill("SIGTERM");
              // Forcer la fermeture après un délai si nécessaire
              setTimeout(() => {
                if (!journalctlProcess.killed) {
                  journalctlProcess.kill("SIGKILL");
                }
              }, 2000);
            } catch (error) {
              logger.warn("Erreur lors du nettoyage du processus", {
                error: error.message,
              });
            }
          }
        },
      },
    };
  } catch (error) {
    logger.error("Erreur lors de la récupération des logs HAProxy", {
      error: error.message,
    });
    throw error;
  }
}
