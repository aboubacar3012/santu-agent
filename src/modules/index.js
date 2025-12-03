/**
 * Registre central des modules disponibles.
 *
 * Ce module permet de charger et d'enregistrer dynamiquement les modules
 * disponibles dans l'agent. Chaque module doit exposer une interface standardisée :
 * - actions: objet contenant les fonctions d'action du module
 * - validator: objet contenant les fonctions de validation du module
 *
 * @module modules/index
 */

import * as dockerModule from "./docker/index.js";

/**
 * Registre des modules disponibles
 * @type {Map<string, Object>}
 */
const modules = new Map();

/**
 * Enregistre un module
 * @param {string} name - Nom du module (ex: "docker", "ssh")
 * @param {Object} module - Module à enregistrer
 * @param {Object} module.actions - Actions du module
 * @param {Object} module.validator - Validator du module
 */
export function registerModule(name, module) {
  if (!module.actions || !module.validator) {
    throw new Error(`Le module ${name} doit exporter 'actions' et 'validator'`);
  }
  modules.set(name, module);
}

/**
 * Récupère un module enregistré
 * @param {string} name - Nom du module
 * @returns {Object|null} Module ou null si non trouvé
 */
export function getModule(name) {
  return modules.get(name) || null;
}

/**
 * Liste tous les modules enregistrés
 * @returns {Array<string>} Liste des noms de modules
 */
export function listModules() {
  return Array.from(modules.keys());
}

// Enregistrer le module Docker par défaut
registerModule("docker", dockerModule);
