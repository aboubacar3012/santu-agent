/**
 * Actions SSH pour l'agent.
 *
 * Ce module encapsule toutes les opérations autorisées sur les clés SSH afin de :
 * - centraliser la récupération des clés SSH du serveur,
 * - éliminer les doublons,
 * - fournir des réponses formatées prêtes à être envoyées via WebSocket.
 *
 * @module modules/ssh/actions
 */

import { logger } from "../../shared/logger.js";
import { executeCommand } from "../../shared/executor.js";
import { validateSshParams } from "./validator.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * Parse une ligne de clé SSH au format OpenSSH
 * @param {string} line - Ligne de clé SSH
 * @returns {Object|null} Clé parsée ou null si invalide
 */
function parseSshKey(line) {
  // Nettoyer la ligne (enlever les commentaires, espaces)
  const cleaned = line.trim();
  if (!cleaned || cleaned.startsWith("#")) {
    return null;
  }

  // Format OpenSSH : "type keydata [comment]"
  const parts = cleaned.split(/\s+/);
  if (parts.length < 2) {
    return null;
  }

  const type = parts[0];
  const keyData = parts[1];
  const comment = parts.slice(2).join(" ") || null;

  // Valider le type de clé
  const validTypes = [
    "ssh-rsa",
    "ssh-dss",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-ed25519",
  ];

  if (!validTypes.includes(type)) {
    return null;
  }

  // Extraire le type court (rsa, ed25519, etc.)
  const shortType = type.replace("ssh-", "").replace("ecdsa-sha2-", "");

  return {
    type: shortType,
    publicKey: `${type} ${keyData}${comment ? ` ${comment}` : ""}`,
    fullLine: cleaned,
  };
}

/**
 * Récupère le fingerprint d'une clé SSH
 * @param {string} publicKey - Clé publique complète
 * @returns {Promise<string|null>} Fingerprint ou null si erreur
 */
async function getFingerprint(publicKey) {
  try {
    // Utiliser ssh-keygen pour obtenir le fingerprint
    const { stdout, stderr, error } = await executeCommand(
      `echo "${publicKey}" | ssh-keygen -lf -`,
      { timeout: 5000 }
    );

    if (error || stderr) {
      logger.debug("Impossible de récupérer le fingerprint", {
        error: stderr,
      });
      return null;
    }

    // Format: "256 SHA256:xxxxx comment (RSA)"
    const match = stdout.match(/SHA256:([^\s]+)/);
    if (match) {
      return `SHA256:${match[1]}`;
    }

    return null;
  } catch (error) {
    logger.debug("Erreur lors de la récupération du fingerprint", {
      error: error.message,
    });
    return null;
  }
}

/**
 * Récupère la liste des utilisateurs système
 * @returns {Promise<Array<string>>} Liste des utilisateurs
 */
async function getSystemUsers() {
  try {
    // Utiliser getent passwd pour obtenir tous les utilisateurs
    const { stdout, stderr, error } = await executeCommand("getent passwd", {
      timeout: 10000,
    });

    if (error || stderr) {
      logger.warn("Erreur lors de la récupération des utilisateurs", {
        error: stderr,
      });
      // Fallback sur /etc/passwd
      try {
        const passwdContent = readFileSync("/etc/passwd", "utf-8");
        return passwdContent
          .split("\n")
          .filter((line) => line.trim() && !line.startsWith("#"))
          .map((line) => line.split(":")[0]);
      } catch (fallbackError) {
        logger.error("Impossible de lire /etc/passwd", {
          error: fallbackError.message,
        });
        return [];
      }
    }

    return stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.split(":")[0])
      .filter((user) => user);
  } catch (error) {
    logger.error("Erreur lors de la récupération des utilisateurs", {
      error: error.message,
    });
    return [];
  }
}

/**
 * Récupère le répertoire home d'un utilisateur
 * @param {string} username - Nom d'utilisateur
 * @returns {Promise<string|null>} Chemin du home ou null
 */
async function getUserHome(username) {
  try {
    const { stdout, stderr, error } = await executeCommand(
      `getent passwd ${username} | cut -d: -f6`,
      { timeout: 5000 }
    );

    if (error || stderr || !stdout.trim()) {
      return null;
    }

    return stdout.trim();
  } catch (error) {
    logger.debug("Impossible de récupérer le home de l'utilisateur", {
      username,
      error: error.message,
    });
    return null;
  }
}

/**
 * Récupère les clés SSH d'un utilisateur
 * @param {string} username - Nom d'utilisateur
 * @param {string} homeDir - Répertoire home de l'utilisateur
 * @returns {Promise<Array<Object>>} Liste des clés trouvées avec métadonnées
 */
async function getUserSshKeys(username, homeDir) {
  const keys = [];
  const sshDir = join(homeDir, ".ssh");

  // Vérifier que le répertoire .ssh existe
  if (!existsSync(sshDir)) {
    return keys;
  }

  // Lire authorized_keys
  const authorizedKeysPath = join(sshDir, "authorized_keys");
  if (existsSync(authorizedKeysPath)) {
    try {
      const content = readFileSync(authorizedKeysPath, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        const parsed = parseSshKey(line);
        if (parsed) {
          keys.push({
            ...parsed,
            source: authorizedKeysPath,
            username,
          });
        }
      }
    } catch (error) {
      logger.debug("Impossible de lire authorized_keys", {
        path: authorizedKeysPath,
        error: error.message,
      });
    }
  }

  // Lire les fichiers id_*.pub
  try {
    const { stdout, stderr } = await executeCommand(
      `find "${sshDir}" -maxdepth 1 -name "id_*.pub" -type f 2>/dev/null`,
      { timeout: 5000 }
    );

    if (!stderr && stdout.trim()) {
      const pubFiles = stdout
        .trim()
        .split("\n")
        .filter((f) => f.trim());
      for (const filePath of pubFiles) {
        try {
          const content = readFileSync(filePath.trim(), "utf-8");
          const parsed = parseSshKey(content);
          if (parsed) {
            keys.push({
              ...parsed,
              source: filePath.trim(),
              username,
            });
          }
        } catch (error) {
          logger.debug("Impossible de lire le fichier de clé publique", {
            path: filePath,
            error: error.message,
          });
        }
      }
    }
  } catch (error) {
    logger.debug("Erreur lors de la recherche des clés publiques", {
      username,
      error: error.message,
    });
  }

  return keys;
}

/**
 * Liste toutes les clés SSH du serveur sans duplication
 * @param {Object} params - Paramètres (non utilisés pour l'instant)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Array>} Liste des clés SSH uniques
 */
export async function listSshKeys(params = {}, callbacks = {}) {
  try {
    validateSshParams("list", params);

    logger.debug("Début de la récupération des clés SSH");

    // Récupérer tous les utilisateurs
    const users = await getSystemUsers();
    logger.debug(`Trouvé ${users.length} utilisateurs`);

    // Map pour stocker les clés uniques (clé publique -> métadonnées)
    const keysMap = new Map();

    // Parcourir chaque utilisateur
    for (const username of users) {
      try {
        const homeDir = await getUserHome(username);
        if (!homeDir) {
          continue;
        }

        const userKeys = await getUserSshKeys(username, homeDir);

        // Ajouter chaque clé à la map (déduplication)
        for (const key of userKeys) {
          const keyId = key.publicKey.trim();

          if (keysMap.has(keyId)) {
            // Clé déjà trouvée, ajouter l'utilisateur et la source
            const existing = keysMap.get(keyId);
            if (!existing.users.includes(username)) {
              existing.users.push(username);
            }
            if (!existing.sources.includes(key.source)) {
              existing.sources.push(key.source);
            }
          } else {
            // Nouvelle clé
            keysMap.set(keyId, {
              publicKey: key.publicKey,
              type: key.type,
              users: [username],
              sources: [key.source],
              fingerprint: null, // Sera rempli plus tard si nécessaire
            });
          }
        }
      } catch (error) {
        logger.debug("Erreur lors du traitement de l'utilisateur", {
          username,
          error: error.message,
        });
        // Continuer avec le prochain utilisateur
      }
    }

    // Convertir la map en tableau
    const uniqueKeys = Array.from(keysMap.values());

    // Optionnel : récupérer les fingerprints (peut être lent)
    // Pour l'instant, on les laisse à null pour des raisons de performance
    // Si besoin, on peut les récupérer en parallèle avec Promise.all

    logger.info(
      `Récupération terminée : ${uniqueKeys.length} clés SSH uniques`
    );

    return uniqueKeys;
  } catch (error) {
    logger.error("Erreur lors de la récupération des clés SSH", {
      error: error.message,
    });
    throw error;
  }
}
