/**
 * Action start - Démarre un conteneur Docker
 *
 * @module modules/docker/actions/start
 */

import { getDocker } from "../manager.js";
import { logger } from "../../../shared/logger.js";
import { validateDockerParams } from "../validator.js";

/**
 * Démarre un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Résultat
 */
export async function startContainer(params, callbacks = {}) {
  try {
    const docker = getDocker();
    const { container } = validateDockerParams("start", params);
    const containerObj = docker.getContainer(container);
    await containerObj.start();
    logger.info("Conteneur démarré", { container });
    return { success: true, message: `Conteneur ${container} démarré` };
  } catch (error) {
    logger.error("Erreur lors du démarrage du conteneur", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}

