/**
 * Validation et sanitization des commandes reçues via WebSocket.
 *
 * Ce module concentre toutes les règles de sécurité applicables aux actions
 * Docker afin d'éviter la duplication de logique dans les handlers.
 *
 * @module utils/validator
 */

/**
 * Liste blanche des actions Docker autorisées
 */
const ALLOWED_DOCKER_ACTIONS = [
  "list",
  "inspect",
  "start",
  "stop",
  "restart",
  "logs",
  "stats",
  "exec",
];

/**
 * Valide qu'une action Docker est autorisée
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidDockerAction(action) {
  return ALLOWED_DOCKER_ACTIONS.includes(action);
}

/**
 * Sanitize un nom de conteneur (empêche l'injection de commandes)
 * @param {string} containerName - Nom du conteneur
 * @returns {string} Nom sanitizé
 */
export function sanitizeContainerName(containerName) {
  if (!containerName || typeof containerName !== "string") {
    throw new Error("Nom de conteneur invalide");
  }
  // Autoriser uniquement lettres, chiffres, tirets, underscores et points
  const sanitized = containerName.replace(/[^a-zA-Z0-9._-]/g, "");
  if (sanitized.length === 0) {
    throw new Error("Nom de conteneur vide après sanitization");
  }
  return sanitized;
}

/**
 * Valide les paramètres d'une action Docker
 * @param {string} action - Action Docker
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateDockerParams(action, params) {
  switch (action) {
    case "list":
      return { all: params.all === true || params.all === "true" };
    case "inspect":
    case "start":
    case "stop":
    case "restart":
    case "logs":
    case "stats":
      if (!params.container) {
        throw new Error("Le paramètre 'container' est requis");
      }
      return {
        container: sanitizeContainerName(params.container),
        ...(action === "logs" && {
          tail: params.tail ? parseInt(params.tail, 10) : 100,
          follow: params.follow === true || params.follow === "true",
        }),
      };
    case "exec":
      if (!params.container || !params.command) {
        throw new Error(
          "Les paramètres 'container' et 'command' sont requis"
        );
      }
      return {
        container: sanitizeContainerName(params.container),
        command: Array.isArray(params.command)
          ? params.command
          : [params.command],
      };
    default:
      return params;
  }
}

