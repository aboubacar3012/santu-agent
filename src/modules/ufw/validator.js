/**
 * Validation des actions UFW.
 *
 * Ce module concentre toutes les règles de validation applicables aux actions
 * UFW afin d'éviter la duplication de logique dans les handlers.
 *
 * @module modules/ufw/validator
 */

/**
 * Liste blanche des actions UFW autorisées
 */
const ALLOWED_UFW_ACTIONS = ["list"];

/**
 * Valide qu'une action UFW est autorisée
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidUfwAction(action) {
  return ALLOWED_UFW_ACTIONS.includes(action);
}

/**
 * Interface standardisée pour le validator
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidAction(action) {
  return isValidUfwAction(action);
}

/**
 * Valide les paramètres d'une action UFW
 * @param {string} action - Action UFW
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateUfwParams(action, params) {
  return validateParams(action, params);
}

/**
 * Interface standardisée pour la validation des paramètres
 * @param {string} action - Action UFW
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateParams(action, params) {
  switch (action) {
    case "list":
      // Pour l'instant, pas de paramètres requis pour list
      return {};
    default:
      return params;
  }
}

