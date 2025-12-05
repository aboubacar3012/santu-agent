/**
 * Action delete-cron - Supprime une tâche cron dans /etc/cron.d/
 *
 * @module modules/cron/actions/delete-cron
 */

import { logger } from "../../../shared/logger.js";
import { validateCronParams } from "../validator.js";
import { executeHostCommand, hostFileExists } from "./utils.js";

/**
 * Génère un nom de fichier slug à partir d'un nom de tâche
 * Tous les fichiers cron personnalisés commencent par "agent-cron"
 * @param {string} taskName - Nom de la tâche
 * @returns {string} Nom de fichier slug avec préfixe "agent-cron"
 */
function generateFileName(taskName) {
  const slug = taskName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]/g, "") // Supprimer les caractères spéciaux
    .replace(/\s+/g, "-") // Remplacer les espaces par des tirets
    .replace(/-+/g, "-") // Remplacer les tirets multiples par un seul
    .replace(/^-+|-+$/g, ""); // Supprimer les tirets en début/fin

  // Ajouter le préfixe "agent-cron" si le slug n'est pas vide
  return slug ? `agent-cron-${slug}` : "";
}

/**
 * Supprime une tâche cron dans /etc/cron.d/
 * @param {Object} params - Paramètres de la tâche cron
 * @param {string} params.task_name - Nom de la tâche à supprimer
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Résultat de l'opération
 */
export async function deleteCronJob(params = {}, callbacks = {}) {
  try {
    // Valider les paramètres
    const validatedParams = validateCronParams("delete-cron", params);
    const { task_name } = validatedParams;

    logger.debug("Début de la suppression d'une tâche cron", {
      task_name,
    });

    const cronDir = "/etc/cron.d";
    const fileName = generateFileName(task_name);

    if (!fileName) {
      throw new Error(
        "Impossible de générer un nom de fichier valide à partir du nom de la tâche"
      );
    }

    const filePath = `${cronDir}/${fileName}`;

    // Vérifier si le fichier existe
    const fileExists = await hostFileExists(filePath);
    if (!fileExists) {
      throw new Error(
        `La tâche cron "${task_name}" n'existe pas (fichier: ${fileName})`
      );
    }

    // Supprimer le fichier
    logger.debug("Suppression du fichier cron", { filePath });
    const deleteResult = await executeHostCommand(`rm -f '${filePath}'`);

    if (deleteResult.error) {
      throw new Error(
        `Erreur lors de la suppression du fichier cron: ${deleteResult.stderr}`
      );
    }

    logger.info("Tâche cron supprimée avec succès", {
      task_name,
      filePath,
    });

    return {
      success: true,
      task_name,
      file_path: filePath,
      message: `Tâche cron "${task_name}" supprimée avec succès`,
    };
  } catch (error) {
    logger.error("Erreur lors de la suppression de la tâche cron", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}
