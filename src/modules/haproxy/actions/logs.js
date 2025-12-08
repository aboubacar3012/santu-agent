/**
 * Action logs - Récupère les logs HAProxy en temps réel ou en une fois
 *
 * @module modules/haproxy/actions/logs
 */

import { spawn, exec } from "child_process";
import { promisify } from "util";
import { logger } from "../../../shared/logger.js";
import { validateHaproxyParams } from "../validator.js";

const execAsync = promisify(exec);

/**
 * Récupère les logs HAProxy en temps réel via journalctl ou tous les logs d'un coup
 * @param {Object} params - Paramètres
 * @param {boolean} [params.stream=true] - Si true, stream les logs en temps réel. Si false, retourne tous les logs
 * @param {number} [params.lines] - Nombre de lignes à récupérer si stream=false (par défaut: tous)
 * @param {Object} [callbacks] - Callbacks pour le streaming
 * @param {Function} [callbacks.onStream] - Callback pour les données de stream
 * @returns {Promise<Object>} Informations de stream ou logs complets
 */
export async function getHaproxyLogs(params = {}, callbacks = {}) {
  try {
    validateHaproxyParams("logs", params);

    const { stream = true, lines } = params;

    // Mode récupération complète (non-streaming)
    if (!stream) {
      logger.debug("Récupération complète des logs HAProxy", { lines });

      let journalctlCommand = "journalctl -u haproxy --no-pager";
      if (lines) {
        journalctlCommand += ` -n ${lines}`;
      }

      const escapedCommand = journalctlCommand.replace(/'/g, "'\"'\"'");
      const nsenterCommand = `nsenter -t 1 -m -u -i -n -p -- sh -c '${escapedCommand}'`;

      try {
        const { stdout, stderr } = await execAsync(nsenterCommand, {
          maxBuffer: 10 * 1024 * 1024, // 10MB max buffer
        });

        if (stderr) {
          logger.warn("Avertissements journalctl", { stderr });
        }

        const allLogs = stdout.split("\n").filter((line) => line.trim());

        return {
          success: true,
          logs: allLogs,
          count: allLogs.length,
        };
      } catch (error) {
        logger.error("Erreur lors de la récupération des logs HAProxy", {
          error: error.message,
        });
        throw new Error(
          `Erreur lors de la récupération des logs: ${error.message}`
        );
      }
    }

    // Mode streaming (comportement par défaut)
    if (!callbacks.onStream) {
      throw new Error(
        "onStream callback est requis pour le streaming des logs"
      );
    }

    logger.debug("Début du streaming des logs HAProxy");

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
    journalctlProcess.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      // Garder la dernière ligne incomplète dans le buffer
      buffer = lines.pop() || "";

      // Envoyer chaque ligne complète via le callback
      for (const line of lines) {
        if (line.trim()) {
          callbacks.onStream("stdout", line + "\n");
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
        mode: "haproxy.logs.follow",
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
