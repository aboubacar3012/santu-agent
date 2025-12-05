/**
 * Action exec - Exécute une commande dans un conteneur Docker
 *
 * @module modules/docker/actions/exec
 */

import { getDocker } from "../manager.js";
import { logger } from "../../../shared/logger.js";
import { validateDockerParams } from "../validator.js";

/**
 * Exécute une commande dans un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @param {string|Array} params.command - Commande à exécuter
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Résultat de l'exécution
 */
export async function execContainer(params, callbacks = {}) {
  try {
    const docker = getDocker();
    const { container, command } = validateDockerParams("exec", params);
    const containerObj = docker.getContainer(container);

    const exec = await containerObj.exec({
      Cmd: Array.isArray(command) ? command : [command],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    let stdout = "";
    let stderr = "";

    return new Promise((resolve, reject) => {
      stream.on("data", (chunk) => {
        const output = chunk.toString();
        // Docker envoie les données avec un préfixe de 8 bytes
        if (chunk[0] === 1) {
          stdout += output.slice(8);
        } else if (chunk[0] === 2) {
          stderr += output.slice(8);
        } else {
          stdout += output;
        }
      });

      stream.on("end", () => {
        resolve({ stdout, stderr, exitCode: 0 });
      });

      stream.on("error", (error) => {
        reject(error);
      });
    });
  } catch (error) {
    logger.error("Erreur lors de l'exécution dans le conteneur", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}

