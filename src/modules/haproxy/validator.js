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
const ALLOWED_HAPROXY_ACTIONS = [
  "list",
  "add-app",
  "app-list",
  "remove-app",
  "ansible-run",
];

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
    case "app-list":
      // Pas de paramètres requis pour app-list
      return {};
    case "ansible-run":
      // Pas de paramètres requis pour ansible-run
      return {};
    case "remove-app":
      if (!params || typeof params !== "object") {
        throw new Error("Les paramètres doivent être un objet");
      }

      // Validation app_slug
      if (!params.app_slug || typeof params.app_slug !== "string") {
        throw new Error(
          "app_slug est requis et doit être une chaîne de caractères"
        );
      }
      const trimmedAppSlug = params.app_slug.trim();
      if (!trimmedAppSlug) {
        throw new Error("app_slug ne peut pas être vide");
      }
      // Validation regex : lettres, chiffres, tirets, 3-63 caractères
      const appSlugRegex = /^[a-zA-Z][a-zA-Z0-9-]{1,62}$/;
      if (!appSlugRegex.test(trimmedAppSlug)) {
        throw new Error(
          "app_slug est invalide. Utilisez uniquement des lettres, chiffres et tirets (3-63 caractères, commençant par une lettre)."
        );
      }

      return {
        app_slug: trimmedAppSlug,
      };
    case "add-app":
      if (!params || typeof params !== "object") {
        throw new Error("Les paramètres doivent être un objet");
      }

      // Validation app_name
      if (!params.app_name || typeof params.app_name !== "string") {
        throw new Error(
          "app_name est requis et doit être une chaîne de caractères"
        );
      }
      const trimmedAppName = params.app_name.trim();
      if (!trimmedAppName) {
        throw new Error("app_name ne peut pas être vide");
      }
      // Validation regex : lettres, chiffres, tirets, 3-63 caractères
      const appNameRegex = /^[a-zA-Z][a-zA-Z0-9-]{1,62}$/;
      if (!appNameRegex.test(trimmedAppName)) {
        throw new Error(
          "app_name est invalide. Utilisez uniquement des lettres, chiffres et tirets (3-63 caractères, commençant par une lettre)."
        );
      }

      // Validation app_domain
      if (!params.app_domain || typeof params.app_domain !== "string") {
        throw new Error(
          "app_domain est requis et doit être une chaîne de caractères"
        );
      }
      const trimmedDomain = params.app_domain.trim();
      if (!trimmedDomain) {
        throw new Error("app_domain ne peut pas être vide");
      }
      // Validation format domaine
      const domainRegex = /^(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,}$/;
      if (!domainRegex.test(trimmedDomain)) {
        throw new Error(
          "app_domain est invalide. Utilisez un domaine au format exemple.elyamaje.com."
        );
      }

      // Validation app_backend_port
      if (
        params.app_backend_port === undefined ||
        params.app_backend_port === null
      ) {
        throw new Error("app_backend_port est requis");
      }
      const parsedPort = Number.parseInt(String(params.app_backend_port), 10);
      if (Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error("app_backend_port doit être un port valide (1-65535)");
      }

      // app_backend_host (optionnel, défaut: "127.0.0.1")
      const appBackendHost =
        params.app_backend_host && typeof params.app_backend_host === "string"
          ? params.app_backend_host.trim()
          : "127.0.0.1";

      // app_slug (optionnel, généré automatiquement si non fourni)
      let appSlug = params.app_slug;
      if (!appSlug || typeof appSlug !== "string" || !appSlug.trim()) {
        // Générer le slug automatiquement
        appSlug = trimmedAppName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
      } else {
        appSlug = appSlug.trim();
      }

      return {
        app_name: trimmedAppName,
        app_domain: trimmedDomain,
        app_backend_host: appBackendHost,
        app_backend_port: parsedPort,
        app_slug: appSlug,
      };
    default:
      return params;
  }
}
