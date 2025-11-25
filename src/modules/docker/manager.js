/**
 * Gestionnaire Docker pour l'agent.
 *
 * Ce module encapsule la création et le partage d'une instance Dockerode.
 * Il s'assure qu'une seule connexion au socket Docker est ouverte pendant toute
 * la durée de vie du processus, évitant les reconnections inutiles.
 *
 * @module modules/docker/manager
 */

import Docker from "dockerode";
import { logger } from "../../utils/logger.js";

/**
 * Instance Docker globale (lazy-loaded).
 * On reste volontairement en module-scope pour la partager entre toutes les actions.
 * @type {Docker|null}
 */
let docker = null;

/**
 * Initialise la connexion Docker si nécessaire.
 *
 * @param {string} [socketPath="/var/run/docker.sock"] - Chemin du socket Docker
 * @returns {Docker} Instance Docker initialisée
 */
export function initDocker(socketPath = "/var/run/docker.sock") {
  if (!docker) {
    try {
      docker = new Docker({ socketPath });
      logger.info("Docker initialisé", { socketPath });
    } catch (error) {
      logger.error("Erreur lors de l'initialisation Docker", {
        error: error.message,
      });
      throw error;
    }
  }
  return docker;
}

/**
 * Récupère l'instance Docker existante, ou l'initialise avec la config courante.
 *
 * @returns {Docker} Instance Docker prête à l'emploi
 */
export function getDocker() {
  if (!docker) {
    const socketPath = process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";
    return initDocker(socketPath);
  }
  return docker;
}

