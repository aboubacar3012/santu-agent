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
          users.push(parsed);
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
            users.push(parsed);
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

    logger.info(`Récupération terminée : ${users.length} utilisateurs trouvés`);

    return users;
  } catch (error) {
    logger.error("Erreur lors de la récupération des utilisateurs", {
      error: error.message,
    });
    throw error;
  }
}

