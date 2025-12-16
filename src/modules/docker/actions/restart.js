/**
 * Action restart - Redémarre un conteneur Docker
 *
 * @module modules/docker/actions/restart
 */

import { getDocker } from "../manager.js";
import { logger } from "../../../shared/logger.js";
import { validateDockerParams } from "../validator.js";
import { requireRole } from "../../../websocket/auth.js";

/**
 * Redémarre un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Résultat
 */
export async function restartContainer(params, callbacks = {}) {
  try {
    // Vérifier les permissions : ADMIN, OWNER et EDITOR peuvent redémarrer un conteneur
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER", "EDITOR"],
      "redémarrer un conteneur Docker"
    );

    const docker = getDocker();
    const { container } = validateDockerParams("restart", params);
    const containerObj = docker.getContainer(container);
    await containerObj.restart();
    logger.info("Conteneur redémarré", { container });
    return { success: true, message: `Conteneur ${container} redémarré` };
  } catch (error) {
    logger.error("Erreur lors du redémarrage du conteneur", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}

