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
 * Equivalent shell de :
 * groups=$(id -nG "$user" 2>/dev/null | tr ' ' ',')
 *
 * Retourne une string "group1,group2"
 */
async function getUserGroupsRaw(username) {
  const { stdout } = await executeCommand(
    `id -nG ${username} 2>/dev/null | tr ' ' ',' || echo ""`
  );

  return stdout.trim();
}

/**
 * Liste complète des utilisateurs avec :
 * user, uid, gid, home, shell, comment (GECOS), groups
 */
export async function listUsers(params = {}, callbacks = {}) {
  try {
    validateUserParams("list", params);

    const passwdContent = readFileSync("/etc/passwd", "utf-8");
    const lines = passwdContent.split("\n");

    const groupContent = readFileSync("/etc/group", "utf-8");
    const gidToName = new Map();
    groupContent.split("\n").forEach((line) => {
      const [groupName, , gid] = line.split(":");
      if (groupName && gid) gidToName.set(gid.trim(), groupName.trim());
    });

    const users = [];

    for (const line of lines) {
      const cleaned = line.trim();
      if (!cleaned || cleaned.startsWith("#")) continue;

      // Parse comme dans le shell : user:pass:uid:gid:gecos:home:shell
      const parts = cleaned.split(":");
      if (parts.length < 7) continue;

      const [user, pass, uid, gid, gecos, home, shell] = parts;

      // On ne filtre PAS ici -> même comportement que le script shell
      // Si tu veux filtrer les UID < 1000, on peut le réactiver plus tard

      // Equivalent exact du shell
      const groups_raw = await getUserGroupsRaw(user);
      const groups = groups_raw
        ? groups_raw
            .split(",")
            .map((g) => g.trim())
            .filter(Boolean)
        : [];
      const namedGroups = groups.map((g) => gidToName.get(g) || g);

      users.push({
        user,
        uid,
        gid,
        home,
        shell,
        comment: gecos,
        groups: namedGroups,
        groups_raw,
      });
    }

    logger.info(`listUsers terminé : ${users.length} utilisateurs trouvés`);
    return users;
  } catch (error) {
    logger.error("Erreur dans listUsers", { error: error.message });
    throw error;
  }
}
