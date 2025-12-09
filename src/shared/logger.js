/**
 * Logger structuré pour l'agent.
 *
 * Ce mini-wrapper permet d'unifier le format des logs et de contrôler le niveau
 * d'affichage sans dépendre d'une lib externe. Les messages respectent tous
 * le schéma : `[timestamp] [LEVEL] message {meta}`.
 *
 * @module shared/logger
 */

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Niveau courant calculé à partir de la config.
 * On retombe sur `debug` si la valeur fournie n'existe pas (pour voir tous les logs en développement).
 */
const currentLogLevel =
  LOG_LEVELS[process.env.AGENT_LOG_LEVEL || "debug"] || LOG_LEVELS.debug;

/**
 * Codes de couleur ANSI pour les terminaux
 */
const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  // Couleurs de ligne (2 couleurs pour alterner)
  line1: "\x1b[38;5;245m", // Gris moyen
  line2: "\x1b[38;5;250m", // Gris clair
};

/**
 * Couleurs par niveau de log
 */
const LEVEL_COLORS = {
  error: COLORS.red,
  warn: COLORS.yellow,
  info: COLORS.cyan,
  debug: COLORS.gray,
};

/**
 * Vérifie si le terminal supporte les couleurs ANSI
 */
const supportsColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

/**
 * Compteur pour alterner les couleurs de ligne
 */
let lineColorCounter = 0;

/**
 * Obtient une couleur de ligne (alterne entre 2 couleurs)
 */
function getLineColor() {
  lineColorCounter++;
  return lineColorCounter % 2 === 0 ? COLORS.line1 : COLORS.line2;
}

/**
 * Formate un message de log avec couleurs
 * @param {string} level - Niveau de log
 * @param {string} message - Message
 * @param {Object} [meta] - Métadonnées additionnelles
 * @returns {string} Message formaté
 */
function formatLog(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  
  const levelColor = supportsColor ? LEVEL_COLORS[level] || "" : "";
  const resetColor = supportsColor ? COLORS.reset : "";
  const timestampColor = supportsColor ? COLORS.dim : "";
  const lineColor = supportsColor ? getLineColor() : "";

  const coloredLevel = `${levelColor}[${level.toUpperCase()}]${resetColor}`;
  const coloredTimestamp = `${timestampColor}[${timestamp}]${resetColor}`;

  // Appliquer la couleur de ligne à toute la ligne
  const fullMessage = `${coloredTimestamp} ${coloredLevel} ${message}${metaStr}`;

  return supportsColor
    ? `${lineColor}${fullMessage}${resetColor}`
    : fullMessage;
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
