/**
 * Validation des actions HAProxy.
 *
 * Ce module concentre toutes les règles de validation applicables aux actions
 * HAProxy afin d'éviter la duplication de logique dans les handlers.
 *
 * @module modules/haproxy/validator
 */

/**
 * Liste blanche des actions HAProxy autorisées
 */
const ALLOWED_HAPROXY_ACTIONS = ["list"];

/**
 * Valide qu'une action HAProxy est autorisée
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidHaproxyAction(action) {
  return ALLOWED_HAPROXY_ACTIONS.includes(action);
}

/**
 * Interface standardisée pour le validator
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidAction(action) {
  return isValidHaproxyAction(action);
}

/**
 * Valide les paramètres d'une action HAProxy
 * @param {string} action - Action HAProxy
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateHaproxyParams(action, params) {
  return validateParams(action, params);
}

/**
 * Interface standardisée pour la validation des paramètres
 * @param {string} action - Action HAProxy
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
