/**
 * Validation des actions Cron.
 *
 * Ce module concentre toutes les règles de validation applicables aux actions
 * Cron afin d'éviter la duplication de logique dans les handlers.
 *
 * @module modules/cron/validator
 */

/**
 * Liste blanche des actions Cron autorisées
 */
const ALLOWED_CRON_ACTIONS = ["list"];

/**
 * Valide qu'une action Cron est autorisée
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidCronAction(action) {
  return ALLOWED_CRON_ACTIONS.includes(action);
}

/**
 * Interface standardisée pour le validator
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidAction(action) {
  return isValidCronAction(action);
}

/**
 * Valide les paramètres d'une action Cron
 * @param {string} action - Action Cron
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateCronParams(action, params) {
  return validateParams(action, params);
}

/**
 * Interface standardisée pour la validation des paramètres
 * @param {string} action - Action Cron
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
