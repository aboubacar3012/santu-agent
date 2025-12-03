/**
 * Validation des actions User.
 *
 * Ce module concentre toutes les règles de validation applicables aux actions
 * User afin d'éviter la duplication de logique dans les handlers.
 *
 * @module modules/user/validator
 */

/**
 * Liste blanche des actions User autorisées
 */
const ALLOWED_USER_ACTIONS = ["list"];

/**
 * Valide qu'une action User est autorisée
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidUserAction(action) {
  return ALLOWED_USER_ACTIONS.includes(action);
}

/**
 * Interface standardisée pour le validator
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidAction(action) {
  return isValidUserAction(action);
}

/**
 * Valide les paramètres d'une action User
 * @param {string} action - Action User
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateUserParams(action, params) {
  return validateParams(action, params);
}

/**
 * Interface standardisée pour la validation des paramètres
 * @param {string} action - Action User
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

