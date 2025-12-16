/**
 * Action remove - Supprime un conteneur Docker
 *
 * @module modules/docker/actions/remove
 */

import { getDocker } from "../manager.js";
import { logger } from "../../../shared/logger.js";
import { validateDockerParams } from "../validator.js";
import { requireRole } from "../../../websocket/auth.js";

/**
 * Supprime un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @param {boolean} [params.force=false] - Forcer la suppression même si le conteneur est en cours d'exécution
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Résultat
 */
export async function removeContainer(params, callbacks = {}) {
  try {
    // Vérifier les permissions : ADMIN, OWNER peuvent supprimer un conteneur
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER"],
      "supprimer un conteneur Docker personnalisé"
    );

    const docker = getDocker();
    const { container, force } = validateDockerParams("remove", params);
    const containerObj = docker.getContainer(container);

    // Supprimer le conteneur (avec force si nécessaire)
    await containerObj.remove({ force: force || false });
    logger.info("Conteneur supprimé", { container, force });
    return {
      success: true,
      message: `Conteneur ${container} supprimé${force ? " (forcé)" : ""}`,
    };
  } catch (error) {
    logger.error("Erreur lors de la suppression du conteneur", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}
