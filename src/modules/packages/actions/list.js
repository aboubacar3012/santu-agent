/**
 * Action list - Liste les packages installés
 *
 * @module modules/packages/actions/list
 */

import { logger } from "../../../shared/logger.js";
import { validatePackagesParams } from "../validator.js";
import {
  detectPackageManager,
  listAptPackages,
} from "./utils.js";

const SUPPORTED_MANAGERS = ["apt"];

/**
 * Liste les packages installés
 * @param {Object} params - Paramètres (non utilisés pour l'instant)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Array>} Liste des packages installés
 */
export async function listPackages(params = {}, callbacks = {}) {
  validatePackagesParams("list", params);
  console.log("Début de la récupération des packages installés");

  const manager = detectPackageManager();
  if (!SUPPORTED_MANAGERS.includes(manager)) {
    throw new Error(`Gestionnaire de packages non supporté: ${manager}`);
  }

  switch (manager) {
    case "apt":
      return listAptPackages();
    default:
      throw new Error(`Gestionnaire de packages non supporté: ${manager}`);
  }
}

