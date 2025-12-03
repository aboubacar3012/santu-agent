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

    // Récupérer tous les groupes et créer une map GID -> nom de groupe
    logger.debug("Récupération de tous les groupes");
    const groupMap = await getAllGroups();
    logger.debug(`Trouvé ${groupMap.size} groupes`);

    // Lire /etc/group pour obtenir les membres de chaque groupe
    const groupMembers = new Map(); // Nom du groupe -> Array d'utilisateurs
    try {
      const groupContent = readFileSync("/etc/group", "utf-8");
      const lines = groupContent.split("\n");
      for (const line of lines) {
        const cleaned = line.trim();
        if (!cleaned || cleaned.startsWith("#")) continue;
        // Format: group:x:gid:user1,user2,user3
        const parts = cleaned.split(":");
        if (parts.length >= 4) {
          const groupName = parts[0];
          const membersStr = parts[3];
          if (membersStr && membersStr.trim()) {
            const members = membersStr
              .split(",")
              .map((u) => u.trim())
              .filter((u) => u);
            groupMembers.set(groupName, members);
          }
        }
      }
      logger.debug(
        `Trouvé ${groupMembers.size} groupes avec membres dans /etc/group`
      );
    } catch (e) {
      logger.debug("Erreur lors de la lecture de /etc/group pour les membres", {
        error: e.message,
      });
    }

    // Construire les groupes pour chaque utilisateur en utilisant includes
    logger.debug(`Construction des groupes pour ${users.length} utilisateurs`);

    users.forEach((user) => {
      const userGroups = new Set();

      // 1. Groupe principal via GID
      const mainGroup = groupMap.get(user.gid);
      if (mainGroup) {
        userGroups.add(mainGroup);
      }

      // 2. Parcourir tous les groupes et vérifier si l'utilisateur est membre avec includes
      for (const [groupName, members] of groupMembers.entries()) {
        if (members.includes(user.username)) {
          userGroups.add(groupName);
        }
      }

      // Assigner les groupes à l'utilisateur
      user.groups = Array.from(userGroups);
      // Le groupe principal est celui correspondant au GID ou le premier trouvé
      user.group =
        mainGroup || (user.groups.length > 0 ? user.groups[0] : null);

      logger.debug(`Groupes pour ${user.username}:`, { groups: user.groups });
    });

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

