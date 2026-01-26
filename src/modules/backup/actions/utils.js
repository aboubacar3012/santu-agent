/**
 * Utilitaires pour les actions Backup
 *
 * Fonctions partagées utilisées par les actions Backup.
 *
 * @module modules/backup/actions/utils
 */

import { logger } from "../../../shared/logger.js";
import { executeCommand } from "../../../shared/executor.js";

/**
 * Exécute une commande sur l'hôte via nsenter
 * @param {string} command - Commande à exécuter
 * @param {Object} [options] - Options d'exécution
 * @returns {Promise<Object>} Résultat de l'exécution
 */
export async function executeHostCommand(command, options = {}) {
  const escapedCommand = command.replace(/'/g, "'\"'\"'");
  const nsenterCommand = `nsenter -t 1 -m -u -i -n -p -- sh -c '${escapedCommand}'`;

  return await executeCommand(nsenterCommand, {
    timeout: options.timeout || 120000, // 2 minutes par défaut
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
  });
}

/**
 * Vérifie si un fichier existe sur l'hôte
 * @param {string} filePath - Chemin du fichier
 * @returns {Promise<boolean>} True si le fichier existe
 */
export async function hostFileExists(filePath) {
  try {
    const result = await executeHostCommand(
      `test -f '${filePath}' && echo 'exists' || echo 'not_exists'`
    );
    return result.stdout.trim() === "exists";
  } catch {
    return false;
  }
}

/**
 * Vérifie si un répertoire existe sur l'hôte
 * @param {string} dirPath - Chemin du répertoire
 * @returns {Promise<boolean>} True si le répertoire existe
 */
export async function hostDirExists(dirPath) {
  try {
    const result = await executeHostCommand(
      `test -d '${dirPath}' && echo 'exists' || echo 'not_exists'`
    );
    return result.stdout.trim() === "exists";
  } catch {
    return false;
  }
}
