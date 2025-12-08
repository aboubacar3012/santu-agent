/**
 * Validation des actions Metrics.
 *
 * Ce module concentre toutes les règles de validation applicables aux actions
 * Metrics afin d'éviter la duplication de logique dans les handlers.
 *
 * @module modules/metrics/validator
 */

/**
 * Liste blanche des actions Metrics autorisées
 */
const ALLOWED_METRICS_ACTIONS = ["stream"];

/**
 * Intervalle de collecte valide (en secondes)
 */
const MIN_INTERVAL = 1; // 1 seconde minimum
const MAX_INTERVAL = 300; // 5 minutes maximum
const DEFAULT_INTERVAL = 10; // 10 secondes par défaut

/**
 * Valide qu'une action Metrics est autorisée
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidMetricsAction(action) {
  return ALLOWED_METRICS_ACTIONS.includes(action);
}

/**
 * Interface standardisée pour le validator
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidAction(action) {
  return isValidMetricsAction(action);
}

/**
 * Valide les paramètres d'une action Metrics
 * @param {string} action - Action Metrics
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateMetricsParams(action, params) {
  return validateParams(action, params);
}

/**
 * Interface standardisée pour la validation des paramètres
 * @param {string} action - Action Metrics
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateParams(action, params) {
  switch (action) {
    case "stream":
      if (!params || typeof params !== "object") {
        return {
          interval: DEFAULT_INTERVAL,
        };
      }

      // Validation de l'intervalle de collecte
      let interval = params.interval;
      if (interval === undefined || interval === null) {
        interval = DEFAULT_INTERVAL;
      } else {
        interval = parseInt(interval, 10);
        if (
          isNaN(interval) ||
          interval < MIN_INTERVAL ||
          interval > MAX_INTERVAL
        ) {
          throw new Error(
            `Interval doit être un nombre entre ${MIN_INTERVAL} et ${MAX_INTERVAL} secondes`
          );
        }
      }

      return {
        interval,
      };
    default:
      return params || {};
  }
}
