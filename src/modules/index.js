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
import * as sshModule from "./ssh/index.js";
import * as cronModule from "./cron/index.js";
import * as userModule from "./user/index.js";
import * as metadataModule from "./metadata/index.js";
import * as ufwModule from "./ufw/index.js";
import * as haproxyModule from "./haproxy/index.js";
import * as activityModule from "./activity/index.js";
import * as metricsModule from "./metrics/index.js";
import * as backupModule from "./backup/index.js";
import * as terminalModule from "./terminal/index.js";
import { logger } from "../shared/logger.js";

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

// Enregistrer les modules par défaut
try {
  logger.debug("Tentative d'enregistrement du module SSH", {
    sshModule,
    hasActions: !!sshModule.actions,
    hasValidator: !!sshModule.validator,
  });
  registerModule("ssh", sshModule);
  logger.info("Module SSH enregistré avec succès");
} catch (error) {
  logger.error("Erreur lors de l'enregistrement du module SSH", {
    error: error.message,
    stack: error.stack,
  });
  throw error;
}

try {
  registerModule("docker", dockerModule);
  logger.info("Module Docker enregistré avec succès");
} catch (error) {
  logger.error("Erreur lors de l'enregistrement du module Docker", {
    error: error.message,
  });
  throw error;
}

try {
  logger.debug("Tentative d'enregistrement du module Cron", {
    cronModule,
    hasActions: !!cronModule.actions,
    hasValidator: !!cronModule.validator,
  });
  registerModule("cron", cronModule);
  logger.info("Module Cron enregistré avec succès");
} catch (error) {
  logger.error("Erreur lors de l'enregistrement du module Cron", {
    error: error.message,
    stack: error.stack,
  });
  throw error;
}

try {
  logger.debug("Tentative d'enregistrement du module User", {
    userModule,
    hasActions: !!userModule.actions,
    hasValidator: !!userModule.validator,
  });
  registerModule("user", userModule);
  logger.info("Module User enregistré avec succès");
} catch (error) {
  logger.error("Erreur lors de l'enregistrement du module User", {
    error: error.message,
    stack: error.stack,
  });
  throw error;
}

try {
  logger.debug("Tentative d'enregistrement du module Metadata", {
    metadataModule,
    hasActions: !!metadataModule.actions,
    hasValidator: !!metadataModule.validator,
  });
  registerModule("metadata", metadataModule);
  logger.info("Module Metadata enregistré avec succès");
} catch (error) {
  logger.error("Erreur lors de l'enregistrement du module Metadata", {
    error: error.message,
    stack: error.stack,
  });
  throw error;
}

try {
  logger.debug("Tentative d'enregistrement du module UFW", {
    ufwModule,
    hasActions: !!ufwModule.actions,
    hasValidator: !!ufwModule.validator,
  });
  registerModule("ufw", ufwModule);
  logger.info("Module UFW enregistré avec succès");
} catch (error) {
  logger.error("Erreur lors de l'enregistrement du module UFW", {
    error: error.message,
    stack: error.stack,
  });
  throw error;
}

try {
  logger.debug("Tentative d'enregistrement du module HAProxy", {
    haproxyModule,
    hasActions: !!haproxyModule.actions,
    hasValidator: !!haproxyModule.validator,
  });
  registerModule("haproxy", haproxyModule);
  logger.info("Module HAProxy enregistré avec succès");
} catch (error) {
  logger.error("Erreur lors de l'enregistrement du module HAProxy", {
    error: error.message,
    stack: error.stack,
  });
  throw error;
}

try {
  logger.debug("Tentative d'enregistrement du module Activity", {
    activityModule,
    hasActions: !!activityModule.actions,
    hasValidator: !!activityModule.validator,
  });
  registerModule("activity", activityModule);
  logger.info("Module Activity enregistré avec succès");
} catch (error) {
  logger.error("Erreur lors de l'enregistrement du module Activity", {
    error: error.message,
    stack: error.stack,
  });
  throw error;
}

try {
  logger.debug("Tentative d'enregistrement du module Metrics", {
    metricsModule,
    hasActions: !!metricsModule.actions,
    hasValidator: !!metricsModule.validator,
  });
  registerModule("metrics", metricsModule);
  logger.info("Module Metrics enregistré avec succès");
} catch (error) {
  logger.error("Erreur lors de l'enregistrement du module Metrics", {
    error: error.message,
    stack: error.stack,
  });
  throw error;
}

try {
  logger.debug("Tentative d'enregistrement du module Backup", {
    backupModule,
    hasActions: !!backupModule.actions,
    hasValidator: !!backupModule.validator,
  });
  registerModule("backup", backupModule);
  logger.info("Module Backup enregistré avec succès");
} catch (error) {
  logger.error("Erreur lors de l'enregistrement du module Backup", {
    error: error.message,
    stack: error.stack,
  });
  throw error;
}

try {
  logger.debug("Tentative d'enregistrement du module Terminal", {
    terminalModule,
    hasActions: !!terminalModule.actions,
    hasValidator: !!terminalModule.validator,
  });
  registerModule("terminal", terminalModule);
  logger.info("Module Terminal enregistré avec succès");
} catch (error) {
  logger.error("Erreur lors de l'enregistrement du module Terminal", {
    error: error.message,
    stack: error.stack,
  });
  throw error;
}

// Log de debug pour vérifier les modules enregistrés
logger.info("Modules disponibles", { modules: listModules() });
