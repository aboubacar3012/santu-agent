/**
 * Action inspect - Inspecte un conteneur Docker
 *
 * @module modules/docker/actions/inspect
 */

import { getDocker } from "../manager.js";
import { logger } from "../../../shared/logger.js";
import { validateDockerParams } from "../validator.js";

/**
 * Inspecte un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Informations du conteneur
 */
export async function inspectContainer(params, callbacks = {}) {
  try {
    const docker = getDocker();
    const { container } = validateDockerParams("inspect", params);
    const containerObj = docker.getContainer(container);
    const info = await containerObj.inspect();
    return {
      id: info.Id,
      name: info.Name,
      state: info.State,
      config: {
        image: info.Config.Image,
        env: info.Config.Env,
        cmd: info.Config.Cmd,
      },
      networkSettings: {
        ipAddress: info.NetworkSettings.IPAddress,
        ports: info.NetworkSettings.Ports,
      },
    };
  } catch (error) {
    logger.error("Erreur lors de l'inspection du conteneur", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}

