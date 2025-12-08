/**
 * Validation des actions Activity.
 *
 * Ce module concentre toutes les règles de validation applicables aux actions
 * Activity afin d'éviter la duplication de logique dans les handlers.
 *
 * @module modules/activity/validator
 */

/**
 * Liste blanche des actions Activity autorisées
 */
const ALLOWED_ACTIVITY_ACTIONS = ["stream"];

/**
 * Sources d'événements valides
 */
const VALID_SOURCES = ["docker", "ssh", "system"];

/**
 * Valide qu'une action Activity est autorisée
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidActivityAction(action) {
  return ALLOWED_ACTIVITY_ACTIONS.includes(action);
}

/**
 * Interface standardisée pour le validator
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidAction(action) {
  return isValidActivityAction(action);
}

/**
 * Valide les paramètres d'une action Activity
 * @param {string} action - Action Activity
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateActivityParams(action, params) {
  return validateParams(action, params);
}

/**
 * Interface standardisée pour la validation des paramètres
 * @param {string} action - Action Activity
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateParams(action, params) {
  switch (action) {
    case "stream":
      if (!params || typeof params !== "object") {
        return {
          sources: VALID_SOURCES,
          filters: {},
        };
      }

      // Validation des sources
      let sources = params.sources;
      if (!sources) {
        sources = VALID_SOURCES;
      } else if (!Array.isArray(sources)) {
        throw new Error("sources doit être un tableau");
      } else {
        // Valider que toutes les sources sont valides
        const invalidSources = sources.filter(
          (s) => !VALID_SOURCES.includes(s)
        );
        if (invalidSources.length > 0) {
          throw new Error(
            `Sources invalides: ${invalidSources.join(
              ", "
            )}. Sources valides: ${VALID_SOURCES.join(", ")}`
          );
        }
        sources = sources;
      }

      // Validation des filtres (optionnel)
      const filters = params.filters || {};
      if (typeof filters !== "object") {
        throw new Error("filters doit être un objet");
      }

      return {
        sources,
        filters,
      };
    default:
      return params || {};
  }
}
