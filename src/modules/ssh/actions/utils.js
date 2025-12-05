/**
 * Utilitaires pour les actions SSH
 *
 * Fonctions partagées utilisées par les actions SSH.
 *
 * @module modules/ssh/actions/utils
 */

import { logger } from "../../../shared/logger.js";
import { executeCommand } from "../../../shared/executor.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * Parse une ligne de clé SSH au format OpenSSH
 * @param {string} line - Ligne de clé SSH
 * @returns {Object|null} Clé parsée ou null si invalide
 */
export function parseSshKey(line) {
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
export async function getFingerprint(publicKey) {
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
export async function getSystemUsers() {
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
export async function getUserHome(username) {
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
export async function getUserSshKeys(username, homeDir) {
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

