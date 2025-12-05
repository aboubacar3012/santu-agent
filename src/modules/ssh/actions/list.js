/**
 * Action list - Liste toutes les clés SSH du serveur
 *
 * @module modules/ssh/actions/list
 */

import { logger } from "../../../shared/logger.js";
import { validateSshParams } from "../validator.js";
import { getSystemUsers, getUserHome, getUserSshKeys } from "./utils.js";

/**
 * Liste toutes les clés SSH du serveur (avec duplication si une clé apparaît plusieurs fois)
 * @param {Object} params - Paramètres (non utilisés pour l'instant)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Array>} Liste de toutes les clés SSH trouvées (une entrée par occurrence)
 */
export async function listSshKeys(params = {}, callbacks = {}) {
  try {
    validateSshParams("list", params);

    logger.debug("Début de la récupération des clés SSH");

    // Récupérer tous les utilisateurs
    const users = await getSystemUsers();
    logger.debug(`Trouvé ${users.length} utilisateurs`);

    // Map pour regrouper les clés identiques par publicKey
    const keysMap = new Map();

    // Parcourir chaque utilisateur
    for (const username of users) {
      try {
        const homeDir = await getUserHome(username);
        if (!homeDir) {
          continue;
        }

        const userKeys = await getUserSshKeys(username, homeDir);

        // Ajouter chaque clé trouvée au tableau (regroupement par publicKey)
        for (const key of userKeys) {
          const keyId = key.publicKey.trim();

          if (keysMap.has(keyId)) {
            // Clé déjà trouvée, ajouter user et source si pas déjà présents
            const existing = keysMap.get(keyId);
            if (!existing.users.includes(username)) {
              existing.users.push(username);
            }
            if (key.source && !existing.sources.includes(key.source)) {
              existing.sources.push(key.source);
            }
          } else {
            // Nouvelle clé
            keysMap.set(keyId, {
              publicKey: key.publicKey,
              type: key.type,
              users: [username],
              sources: key.source ? [key.source] : [],
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

    // Convertir la Map en tableau
    const allKeys = Array.from(keysMap.values());

    // Optionnel : récupérer les fingerprints (peut être lent)
    // Pour l'instant, on les laisse à null pour des raisons de performance
    // Si besoin, on peut les récupérer en parallèle avec Promise.all

    logger.info(`Récupération terminée : ${allKeys.length} clés SSH trouvées`);

    return allKeys;
  } catch (error) {
    logger.error("Erreur lors de la récupération des clés SSH", {
      error: error.message,
    });
    throw error;
  }
}
