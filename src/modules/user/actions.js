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
 * Récupère les groupes d'un utilisateur avec id -nG et les convertit en format séparé par virgules
 * @param {string} username - Nom d'utilisateur
 * @returns {Promise<string>} Groupes séparés par des virgules
 */
async function getUserGroups(username) {
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

/**
 * Liste tous les utilisateurs du système
 * Suit la même logique que: while IFS=: read -r user pass uid gid gecos home shell; do groups=$(id -nG "$user" 2>/dev/null | tr ' ' ','); done < /etc/passwd
 * @param {Object} params - Paramètres (non utilisés pour l'instant)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Array>} Liste de tous les utilisateurs trouvés
 */
export async function listUsers(params = {}, callbacks = {}) {
  logger.error("hello world");
  try {
    validateUserParams("list", params);

    logger.debug("Début de la récupération des utilisateurs système");

    const users = [];

    // Lire /etc/passwd ligne par ligne (comme dans la commande shell)
    try {
      const passwdContent = readFileSync("/etc/passwd", "utf-8");
      const lines = passwdContent.split("\n");

      logger.debug(`Traitement de ${lines.length} lignes de /etc/passwd`);

      // Traiter chaque ligne en parallèle par lots
      const batchSize = 10;
      for (let i = 0; i < lines.length; i += batchSize) {
        const batch = lines.slice(i, i + batchSize);
        const userPromises = batch.map(async (line) => {
          const cleaned = line.trim();

          // Ignorer les lignes vides et les commentaires
          if (!cleaned || cleaned.startsWith("#")) {
            return null;
          }

          // Parser la ligne au format: user:pass:uid:gid:gecos:home:shell
          const parts = cleaned.split(":");
          if (parts.length < 7) {
            return null;
          }

          const [user, pass, uid, gid, gecos, home, shell] = parts;

          // Valider que les champs essentiels existent
          if (!user || !uid || !gid) {
            return null;
          }

          // Filtrer les utilisateurs système (UID < 1000)
          const uidNum = parseInt(uid, 10);
          if (isNaN(uidNum) || uidNum < 1000) {
            return null;
          }

          // Récupérer les groupes avec id -nG (comme dans la commande shell)
          const groupsStr = await getUserGroups(user);

          // Construire l'objet utilisateur (comme dans le JSON de la commande shell)
          return {
            username: user,
            uid: uid,
            gid: gid,
            groups: groupsStr
              ? groupsStr.split(",").filter((g) => g && g.trim())
              : [],
            home: home || "",
            shell: shell || "",
            comment: gecos || "",
            group: groupsStr
              ? groupsStr.split(",").filter((g) => g && g.trim())[0] || null
              : null, // Premier groupe
          };
        });

        const batchResults = await Promise.all(userPromises);
        const validUsers = batchResults.filter((u) => u !== null);
        users.push(...validUsers);
      }
    } catch (error) {
      logger.error("Impossible de lire /etc/passwd", {
        error: error.message,
      });
      throw new Error(
        `Impossible de récupérer les utilisateurs: ${error.message}`
      );
    }

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
