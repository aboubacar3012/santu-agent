/**
 * Action stats - Récupère les statistiques d'un conteneur Docker
 *
 * @module modules/docker/actions/stats
 */

import { getDocker } from "../manager.js";
import { logger } from "../../../shared/logger.js";
import { validateDockerParams } from "../validator.js";
import { calculateCpuPercent } from "./utils.js";
import { requireRole } from "../../../websocket/auth.js";

/**
 * Récupère les statistiques d'un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @param {boolean} [params.stream=false] - Mode streaming
 * @param {Object} [callbacks] - Callbacks pour le streaming
 * @param {Function} [callbacks.onStream] - Callback pour les statistiques en temps réel
 * @returns {Promise<Object>} Statistiques ou informations de stream
 */
export async function getContainerStats(params, callbacks = {}) {
  try {
    // Vérifier les permissions : ADMIN, OWNER, EDITOR et USER peuvent voir les statistiques
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER", "EDITOR", "USER"],
      "consulter les statistiques d'un conteneur Docker"
    );

    const docker = getDocker();
    const { container, stream } = validateDockerParams("stats", params);
    const containerObj = docker.getContainer(container);

    if (stream && callbacks.onStream) {
      // Mode streaming
      const stats = containerObj.stats({ stream: true });
      stats.on("data", (chunk) => {
        try {
          const data = JSON.parse(chunk.toString());
          const statsData = {
            cpu: calculateCpuPercent(data),
            memory: {
              usage: data.memory_stats.usage || 0,
              limit: data.memory_stats.limit || 0,
              percent:
                data.memory_stats.limit > 0
                  ? (
                      (data.memory_stats.usage / data.memory_stats.limit) *
                      100
                    ).toFixed(2)
                  : 0,
            },
            network: data.networks || {},
            blockIO: data.blkio_stats || {},
          };
          callbacks.onStream("stdout", JSON.stringify(statsData));
        } catch (error) {
          logger.error("Erreur lors du parsing des stats", {
            error: error.message,
          });
        }
      });

      stats.on("error", (error) => {
        logger.error("Erreur lors de la récupération des stats", {
          container,
          error: error.message,
        });
      });

      return {
        isStreaming: true,
        initialResponse: {
          stream: "stdout",
          mode: "stats.stream",
        },
        resource: {
          type: "docker-stats",
          cleanup: () => {
            if (stats?.destroy) {
              stats.destroy();
            } else if (stats?.end) {
              stats.end();
            }
          },
        },
      };
    } else {
      // Mode one-shot - récupérer la première donnée du stream
      return new Promise((resolve, reject) => {
        const stats = containerObj.stats({ stream: false });
        stats.on("data", (chunk) => {
          try {
            const data = JSON.parse(chunk.toString());
            resolve({
              cpu: calculateCpuPercent(data),
              memory: {
                usage: data.memory_stats.usage || 0,
                limit: data.memory_stats.limit || 0,
                percent:
                  data.memory_stats.limit > 0
                    ? (
                        (data.memory_stats.usage / data.memory_stats.limit) *
                        100
                      ).toFixed(2)
                    : 0,
              },
              network: data.networks || {},
              blockIO: data.blkio_stats || {},
              type: "one-shot",
            });
            stats.destroy();
          } catch (error) {
            stats.destroy();
            reject(error);
          }
        });

        stats.on("error", (error) => {
          reject(error);
        });
      });
    }
  } catch (error) {
    logger.error("Erreur lors de la récupération des statistiques", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}

