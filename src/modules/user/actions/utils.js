/**
 * Utilitaires pour les actions User
 *
 * Fonctions partagées utilisées par les actions User.
 *
 * @module modules/user/actions/utils
 */

import { logger } from "../../../shared/logger.js";
import { executeCommand } from "../../../shared/executor.js";

/**
 * Récupère les groupes d'un utilisateur avec id -nG et les convertit en format séparé par virgules
 * @param {string} username - Nom d'utilisateur
 * @returns {Promise<string>} Groupes séparés par des virgules
 */
export async function getUserGroups(username) {
  try {
    // Utiliser id -nG pour obtenir tous les noms de groupes (exactement comme dans la commande shell)
    // -G : affiche tous les groupes
    // -n : affiche les noms au lieu des numéros
    const { stdout, stderr, error } = await executeCommand(
      `id -nG ${username} 2>/dev/null || echo ""`,
      { timeout: 3000 }
    );

    if (error) {
      logger.debug(`Erreur id -nG pour ${username}:`, { error, stderr });
      return "";
    }

    if (!stdout || !stdout.trim()) {
      logger.debug(`Pas de sortie pour id -nG ${username}`);
      return "";
    }

    // Format: "group1 group2 group3" (séparés par des espaces)
    // Convertir en "group1,group2,group3" (comme tr ' ' ',')
    const output = stdout.trim();
    const groups = output
      .split(/\s+/)
      .filter((g) => g && g.trim())
      .join(",");

    logger.debug(`id -nG ${username} = "${output}" -> "${groups}"`);

    return groups;
  } catch (error) {
    logger.debug(
      `Exception lors de la récupération des groupes pour ${username}`,
      {
        error: error.message,
      }
    );
    return "";
  }
}

