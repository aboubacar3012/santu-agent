/**
 * Action list - Liste les conteneurs Docker
 *
 * @module modules/docker/actions/list
 */

import { getDocker } from "../manager.js";
import { logger } from "../../../shared/logger.js";
import { validateDockerParams } from "../validator.js";
import {
  fetchContainerStatsSnapshot,
  formatResourceUsage,
} from "./utils.js";
import { requireRole } from "../../../websocket/auth.js";

/**
 * Liste les conteneurs Docker
 * @param {Object} params - Paramètres
 * @param {boolean} [params.all=false] - Inclure les conteneurs arrêtés
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Array>} Liste des conteneurs
 */
export async function listContainers(params = {}, callbacks = {}) {
  try {
    // Vérifier les permissions : ADMIN, OWNER, EDITOR et USER peuvent lister les conteneurs
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER", "EDITOR", "USER"],
      "lister les conteneurs Docker"
    );

    const docker = getDocker();
    const { all = true } = validateDockerParams("list", params);
    const containers = await docker.listContainers({ all });
    const enrichedContainers = await Promise.all(
      containers.map(async (container) => {
        let resourceUsage = null;

        try {
          const stats = await fetchContainerStatsSnapshot(docker, container.Id);
          if (stats) {
            resourceUsage = formatResourceUsage(stats);
          }
        } catch (statsError) {
          logger.warn("Impossible de récupérer les stats du conteneur", {
            containerId: container.Id,
            error: statsError.message,
          });
        }

        return {
          id: container.Id,
          names: container.Names,
          image: container.Image,
          status: container.Status,
          state: container.State,
          created: container.Created,
          ports: container.Ports,
          resourceUsage,
        };
      })
    );

    return enrichedContainers;
  } catch (error) {
    logger.error("Erreur lors de la liste des conteneurs", {
      error: error.message,
    });
    throw error;
  }
}

