/**
 * Validation des actions Metadata.
 *
 * Ce module concentre toutes les règles de validation applicables aux actions
 * Metadata afin d'éviter la duplication de logique dans les handlers.
 *
 * @module modules/metadata/validator
 */

/**
 * Liste blanche des actions Metadata autorisées
 */
const ALLOWED_METADATA_ACTIONS = ["info"];

/**
 * Valide qu'une action Metadata est autorisée
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidMetadataAction(action) {
  return ALLOWED_METADATA_ACTIONS.includes(action);
}

/**
 * Interface standardisée pour le validator
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidAction(action) {
  return isValidMetadataAction(action);
}

/**
 * Valide les paramètres d'une action Metadata
 * @param {string} action - Action Metadata
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateMetadataParams(action, params) {
  return validateParams(action, params);
}

/**
 * Interface standardisée pour la validation des paramètres
 * @param {string} action - Action Metadata
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateParams(action, params) {
  switch (action) {
    case "info":
      // Pour l'instant, pas de paramètres requis pour info
      return {};
    default:
      return params;
  }
}

