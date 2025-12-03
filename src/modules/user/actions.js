/**
 * Actions User pour l'agent.
 *
 * Ce module encapsule toutes les opérations autorisées sur les utilisateurs système afin de :
 * - centraliser la récupération des utilisateurs du serveur,
 * - parser les informations utilisateur depuis /etc/passwd,
 * - fournir des réponses formatées prêtes à être envoyées via WebSocket.
 *
 * @module modules/user/actions
 */

import { logger } from "../../shared/logger.js";
import { executeCommand } from "../../shared/executor.js";
import { validateUserParams } from "./validator.js";
import { readFileSync } from "fs";

/**
 * Récupère les groupes d'un utilisateur avec la commande id -Gn
 * @param {string} username - Nom d'utilisateur
 * @returns {Promise<Array<string>>} Liste des groupes de l'utilisateur
 */
async function getUserGroups(username) {
  try {
    // Utiliser id -Gn <username> pour obtenir tous les noms de groupes
    // -G : affiche tous les groupes
    // -n : affiche les noms au lieu des numéros
    const { stdout, stderr, error } = await executeCommand(
      `id -Gn ${username} 2>/dev/null || echo ""`,
      { timeout: 3000 }
    );

    if (error || !stdout || !stdout.trim()) {
      logger.debug(`Pas de sortie pour id -Gn ${username}`, {
        error: stderr || "aucune sortie",
      });
      return [];
    }

    // Format: "group1 group2 group3" (séparés par des espaces)
    const output = stdout.trim();
    logger.debug(`Sortie de id -Gn pour ${username}: ${output}`);

    // Extraire les groupes (séparés par des espaces)
    const groups = output.split(/\s+/).filter((g) => g && g.trim());

    logger.debug(`Groupes parsés pour ${username}:`, { groups });

    return groups;
  } catch (error) {
    logger.debug(`Erreur lors de la récupération des groupes pour ${username}`, {
      error: error.message,
    });
    return [];
  }
}

/**
 * Parse une ligne de /etc/passwd
 * Format: username:password:uid:gid:comment:home:shell
 * @param {string} line - Ligne de /etc/passwd
 * @returns {Object|null} Utilisateur parsé ou null si invalide
 */
function parsePasswdLine(line) {
  // Nettoyer la ligne
  const cleaned = line.trim();

  // Ignorer les lignes vides et les commentaires
  if (!cleaned || cleaned.startsWith("#")) {
    return null;
  }

  // Parser les champs séparés par ":"
  const parts = cleaned.split(":");

  // Doit avoir au moins 7 champs
  if (parts.length < 7) {
    return null;
  }

  const [username, password, uid, gid, comment, home, shell] = parts;

  // Valider que les champs essentiels existent
  if (!username || !uid || !gid) {
    return null;
  }

  return {
    username: username,
    uid: uid,
    gid: gid,
    home: home || "",
    shell: shell || "",
    comment: comment || "",
    groups: [], // Sera rempli plus tard avec tous les groupes
    group: null, // Groupe principal (sera le premier groupe ou celui correspondant au GID)
  };
}

/**
 * Liste tous les utilisateurs du système
 * @param {Object} params - Paramètres (non utilisés pour l'instant)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Array>} Liste de tous les utilisateurs trouvés
 */
export async function listUsers(params = {}, callbacks = {}) {
  try {
    validateUserParams("list", params);

    logger.debug("Début de la récupération des utilisateurs système");

    const users = [];

    try {
      // Utiliser getent passwd pour obtenir tous les utilisateurs (méthode principale)
      const { stdout, stderr, error } = await executeCommand("getent passwd", {
        timeout: 10000,
      });

      if (error || stderr) {
        logger.warn("Erreur lors de la récupération avec getent passwd", {
          error: stderr,
        });
        // Fallback sur /etc/passwd
        throw new Error("Fallback to /etc/passwd");
      }

      // Parser les résultats de getent passwd
      const lines = stdout.split("\n").filter((line) => line.trim());
      logger.debug(`Trouvé ${lines.length} lignes avec getent passwd`);

      for (const line of lines) {
        const parsed = parsePasswdLine(line);
        if (parsed) {
          // Filtrer les utilisateurs système (UID < 1000)
          const uid = parseInt(parsed.uid, 10);
          if (!isNaN(uid) && uid >= 1000) {
            users.push(parsed);
          }
        }
      }
    } catch (error) {
      // Fallback sur /etc/passwd
      logger.debug("Utilisation du fallback /etc/passwd");
      try {
        const passwdContent = readFileSync("/etc/passwd", "utf-8");
        const lines = passwdContent
          .split("\n")
          .filter((line) => line.trim() && !line.startsWith("#"));

        logger.debug(`Trouvé ${lines.length} lignes dans /etc/passwd`);

        for (const line of lines) {
          const parsed = parsePasswdLine(line);
          if (parsed) {
            // Filtrer les utilisateurs système (UID < 1000)
            const uid = parseInt(parsed.uid, 10);
            if (!isNaN(uid) && uid >= 1000) {
              users.push(parsed);
            }
          }
        }
      } catch (fallbackError) {
        logger.error("Impossible de lire /etc/passwd", {
          error: fallbackError.message,
        });
        throw new Error(
          `Impossible de récupérer les utilisateurs: ${fallbackError.message}`
        );
      }
    }

    // Récupérer les groupes pour chaque utilisateur avec la commande groups
    logger.debug(`Récupération des groupes pour ${users.length} utilisateurs`);
    
    // Récupérer les groupes en parallèle (limité à 10 à la fois pour éviter la surcharge)
    const batchSize = 10;
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      const groupPromises = batch.map(async (user) => {
        const groups = await getUserGroups(user.username);
        return { username: user.username, groups };
      });
      
      const results = await Promise.all(groupPromises);
      
      // Associer les groupes aux utilisateurs
      results.forEach(({ username, groups }) => {
        const user = users.find((u) => u.username === username);
        if (user) {
          user.groups = groups;
          // Le groupe principal est le premier groupe ou celui correspondant au GID
          user.group = groups.length > 0 ? groups[0] : null;
        }
      });
    }
    
    logger.debug(`Groupes récupérés pour tous les utilisateurs`);

    logger.info(
      `Récupération terminée : ${users.length} utilisateurs trouvés avec groupes`
    );

    return users;
  } catch (error) {
    logger.error("Erreur lors de la récupération des utilisateurs", {
      error: error.message,
    });
    throw error;
  }
}

