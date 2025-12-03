/**
 * Validation des actions SSH.
 *
 * Ce module concentre toutes les règles de validation applicables aux actions
 * SSH afin d'éviter la duplication de logique dans les handlers.
 *
 * @module modules/ssh/validator
 */

/**
 * Liste blanche des actions SSH autorisées
 */
const ALLOWED_SSH_ACTIONS = ["list"];

/**
 * Valide qu'une action SSH est autorisée
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidSshAction(action) {
  return ALLOWED_SSH_ACTIONS.includes(action);
}

/**
 * Interface standardisée pour le validator
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidAction(action) {
  return isValidSshAction(action);
}

/**
 * Valide les paramètres d'une action SSH
 * @param {string} action - Action SSH
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateSshParams(action, params) {
  return validateParams(action, params);
}

/**
 * Interface standardisée pour la validation des paramètres
 * @param {string} action - Action SSH
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
