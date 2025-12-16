/**
 * Action list - Liste la configuration HAProxy
 *
 * @module modules/haproxy/actions/list
 */

import { logger } from "../../../shared/logger.js";
import { readFileSync, existsSync } from "fs";
import { validateHaproxyParams } from "../validator.js";
import { requireRole } from "../../../websocket/auth.js";

/**
 * Liste la configuration HAProxy depuis le fichier /etc/haproxy/haproxy.cfg
 * @param {Object} params - Paramètres (non utilisés pour l'instant)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Objet contenant exists et content
 */
export async function listHaproxyConfig(params = {}, callbacks = {}) {
  try {
    // Vérifier les permissions : ADMIN, OWNER, EDITOR et USER peuvent lister la configuration HAProxy
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER", "EDITOR", "USER"],
      "lister la configuration HAProxy"
    );

    validateHaproxyParams("list", params);

    logger.debug("Début de la récupération de la configuration HAProxy");

    const configPath = "/etc/haproxy/haproxy.cfg";

    // Vérifier si le fichier existe
    if (!existsSync(configPath)) {
      logger.debug("Le fichier /etc/haproxy/haproxy.cfg n'existe pas");
      return {
        exists: false,
        content: null,
      };
    }

    // Lire le contenu du fichier
    try {
      const content = readFileSync(configPath, "utf-8");
      logger.info("Configuration HAProxy récupérée avec succès", {
        contentLength: content.length,
      });

      return {
        exists: true,
        content: content,
      };
    } catch (error) {
      logger.error("Erreur lors de la lecture du fichier HAProxy", {
        error: error.message,
        path: configPath,
      });
      throw new Error(
        `Erreur lors de la lecture de ${configPath}: ${error.message}`
      );
    }
  } catch (error) {
    logger.error("Erreur lors de la récupération de la configuration HAProxy", {
      error: error.message,
    });
    throw error;
  }
}

