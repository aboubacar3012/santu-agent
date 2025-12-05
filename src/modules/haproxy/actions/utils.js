/**
 * Utilitaires pour les actions HAProxy
 *
 * Fonctions partagées utilisées par plusieurs actions HAProxy.
 *
 * @module modules/haproxy/actions/utils
 */

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
 * Vérifie la taille d'un fichier sur l'hôte
 * @param {string} filePath - Chemin du fichier
 * @returns {Promise<number>} Taille du fichier en octets, 0 si n'existe pas
 */
export async function getHostFileSize(filePath) {
  try {
    const result = await executeHostCommand(
      `stat -c%s '${filePath}' 2>/dev/null || echo '0'`
    );
    return Number.parseInt(result.stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}
