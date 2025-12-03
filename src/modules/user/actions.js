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
 * Récupère tous les groupes et crée une map GID -> nom de groupe
 * @returns {Promise<Map<string, string>>} Map des GID vers noms de groupes
 */
async function getAllGroups() {
  const groupMap = new Map();

  try {
    // Utiliser getent group pour obtenir tous les groupes
    const { stdout, stderr, error } = await executeCommand("getent group", {
      timeout: 5000,
    });

    if (error || stderr) {
      logger.debug(
        "Erreur avec getent group, utilisation du fallback /etc/group"
      );
      throw new Error("Fallback to /etc/group");
    }

    // Parser les résultats de getent group
    // Format: groupname:password:gid:members
    const lines = stdout.split("\n").filter((line) => line.trim());
    for (const line of lines) {
      const parts = line.trim().split(":");
      if (parts.length >= 3) {
        const groupName = parts[0];
        const gid = parts[2];
        if (groupName && gid) {
          groupMap.set(gid, groupName);
        }
      }
    }
  } catch (error) {
    // Fallback sur /etc/group
    try {
      const groupContent = readFileSync("/etc/group", "utf-8");
      const lines = groupContent.split("\n");
      for (const line of lines) {
        const cleaned = line.trim();
        if (!cleaned || cleaned.startsWith("#")) {
          continue;
        }
        const parts = cleaned.split(":");
        if (parts.length >= 3) {
          const groupName = parts[0];
          const gid = parts[2];
          if (groupName && gid) {
            groupMap.set(gid, groupName);
          }
        }
      }
    } catch (fallbackError) {
      logger.error("Impossible de lire /etc/group", {
        error: fallbackError.message,
      });
    }
  }

  return groupMap;
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
    group: null, // Sera rempli plus tard
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

    // Ajouter les noms de groupes aux utilisateurs
    users.forEach((user) => {
      user.group = groupMap.get(user.gid) || null;
      if (!user.group) {
        logger.debug(
          `Groupe non trouvé pour GID ${user.gid} (utilisateur ${user.username})`
        );
      }
    });

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

