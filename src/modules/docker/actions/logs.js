/**
 * Action logs - Récupère les logs d'un conteneur Docker
 *
 * @module modules/docker/actions/logs
 */

import { getDocker } from "../manager.js";
import { logger } from "../../../shared/logger.js";
import { validateDockerParams } from "../validator.js";
import { requireRole } from "../../../websocket/auth.js";

/**
 * Récupère les logs d'un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @param {number} [params.tail=100] - Nombre de lignes à récupérer
 * @param {boolean} [params.follow=false] - Suivre les logs en temps réel
 * @param {Object} [callbacks] - Callbacks pour le streaming
 * @param {Function} [callbacks.onStream] - Callback pour les données de stream
 * @returns {Promise<Object>} Logs ou informations de stream
 */
export async function getContainerLogs(params, callbacks = {}) {
  try {
    // Vérifier les permissions : ADMIN, OWNER, EDITOR et USER peuvent voir les logs
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER", "EDITOR", "USER"],
      "consulter les logs d'un conteneur Docker"
    );

    const docker = getDocker();
    const { container, tail, follow } = validateDockerParams("logs", params);
    const containerObj = docker.getContainer(container);

    if (follow && callbacks.onStream) {
      // Mode streaming
      const stream = await containerObj.logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: tail || 100,
        timestamps: true,
      });

      stream.on("data", (chunk) => {
        callbacks.onStream("stdout", chunk.toString());
      });

      stream.on("error", (error) => {
        logger.error("Erreur lors de la lecture des logs", {
          container,
          error: error.message,
        });
      });

      return {
        isStreaming: true,
        initialResponse: {
          stream: "stdout",
          mode: "logs.follow",
        },
        resource: {
          type: "docker-logs",
          cleanup: () => {
            if (stream?.destroy) {
              stream.destroy();
            } else if (stream?.end) {
              stream.end();
            }
          },
        },
      };
    } else {
      // Mode one-shot
      const logs = await containerObj.logs({
        stdout: true,
        stderr: true,
        tail: tail || 100,
        timestamps: true,
      });
      return { logs: logs.toString(), type: "one-shot" };
    }
  } catch (error) {
    logger.error("Erreur lors de la récupération des logs", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}

