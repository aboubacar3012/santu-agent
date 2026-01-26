/**
 * Validation des actions Terminal.
 *
 * Ce module concentre toutes les règles de validation applicables aux actions
 * Terminal afin d'éviter la duplication de logique dans les handlers.
 *
 * @module modules/terminal/validator
 */

/**
 * Liste blanche des actions Terminal autorisées
 */
const ALLOWED_TERMINAL_ACTIONS = ["stream"];

/**
 * Valide qu'une action Terminal est autorisée
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidTerminalAction(action) {
  return ALLOWED_TERMINAL_ACTIONS.includes(action);
}

/**
 * Interface standardisée pour le validator
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidAction(action) {
  return isValidTerminalAction(action);
}

/**
 * Valide les paramètres d'une action Terminal
 * @param {string} action - Action Terminal
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateTerminalParams(action, params) {
  return validateParams(action, params);
}

/**
 * Interface standardisée pour la validation des paramètres
 * @param {string} action - Action Terminal
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateParams(action, params) {
  switch (action) {
    case "stream": {
      if (!params || typeof params !== "object") {
        throw new Error("Les paramètres doivent être un objet");
      }

      // cols et rows sont optionnels, avec des valeurs par défaut
      const cols = params.cols && typeof params.cols === "number" ? params.cols : 80;
      const rows = params.rows && typeof params.rows === "number" ? params.rows : 24;

      // Vérifier que cols et rows sont des valeurs raisonnables
      if (cols < 10 || cols > 500) {
        throw new Error("cols doit être entre 10 et 500");
      }
      if (rows < 5 || rows > 200) {
        throw new Error("rows doit être entre 5 et 200");
      }

      return {
        cols,
        rows,
      };
    }
    default:
      return params;
  }
}
