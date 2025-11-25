/**
 * Logger structuré pour l'agent.
 *
 * Ce mini-wrapper permet d'unifier le format des logs et de contrôler le niveau
 * d'affichage sans dépendre d'une lib externe. Les messages respectent tous
 * le schéma : `[timestamp] [LEVEL] message {meta}`.
 *
 * @module utils/logger
 */

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Niveau courant calculé à partir de la config.
 * On retombe sur `info` si la valeur fournie n'existe pas.
 */
const currentLogLevel =
  LOG_LEVELS[process.env.AGENT_LOG_LEVEL || "info"] || LOG_LEVELS.info;

/**
 * Formate un message de log
 * @param {string} level - Niveau de log
 * @param {string} message - Message
 * @param {Object} [meta] - Métadonnées additionnelles
 * @returns {string} Message formaté
 */
function formatLog(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length
    ? ` ${JSON.stringify(meta)}`
    : "";
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

/**
 * Logger avec différents niveaux
 */
export const logger = {
  error: (message, meta) => {
    if (LOG_LEVELS.error <= currentLogLevel) {
      console.error(formatLog("error", message, meta));
    }
  },
  warn: (message, meta) => {
    if (LOG_LEVELS.warn <= currentLogLevel) {
      console.warn(formatLog("warn", message, meta));
    }
  },
  info: (message, meta) => {
    if (LOG_LEVELS.info <= currentLogLevel) {
      console.log(formatLog("info", message, meta));
    }
  },
  debug: (message, meta) => {
    if (LOG_LEVELS.debug <= currentLogLevel) {
      console.log(formatLog("debug", message, meta));
    }
  },
};

