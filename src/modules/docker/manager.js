/**
 * Gestionnaire Docker pour l'agent 
 * @module modules/docker/manager
 */

import Docker from "dockerode";
import { logger } from "../../utils/logger.js";

let docker = null;

/**
 * Initialise la connexion Docker
 * @param {string} [socketPath] - Chemin du socket Docker
 * @returns {Docker} Instance Docker
 */
export function initDocker(socketPath = "/var/run/docker.sock") {
  if (!docker) {
    try {
      docker = new Docker({ socketPath });
      logger.info("Docker initialisé", { socketPath });
    } catch (error) {
      logger.error("Erreur lors de l'initialisation Docker", { error: error.message });
      throw error;
    }
  }
  return docker;
}

/**
 * Obtient l'instance Docker (l'initialise si nécessaire)
 * @returns {Docker} Instance Docker
 */
export function getDocker() {
  if (!docker) {
    const socketPath = process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";
    return initDocker(socketPath);
  }
  return docker;
}

