/**
 * Action stop - Arrête un conteneur Docker
 *
 * @module modules/docker/actions/stop
 */

import { getDocker } from "../manager.js";
import { logger } from "../../../shared/logger.js";
import { validateDockerParams } from "../validator.js";

/**
 * Arrête un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Résultat
 */
export async function stopContainer(params, callbacks = {}) {
  try {
    const docker = getDocker();
    const { container } = validateDockerParams("stop", params);
    const containerObj = docker.getContainer(container);
    await containerObj.stop();
    logger.info("Conteneur arrêté", { container });
    return { success: true, message: `Conteneur ${container} arrêté` };
  } catch (error) {
    logger.error("Erreur lors de l'arrêt du conteneur", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}

