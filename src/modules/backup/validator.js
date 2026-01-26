/**
 * Validation des actions Backup.
 *
 * Ce module concentre toutes les règles de validation applicables aux actions
 * Backup afin d'éviter la duplication de logique dans les handlers.
 *
 * @module modules/backup/validator
 */

/**
 * Liste blanche des actions Backup autorisées
 */
const ALLOWED_BACKUP_ACTIONS = ["toggle-logs-backup"];

/**
 * Valide qu'une action Backup est autorisée
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidBackupAction(action) {
  return ALLOWED_BACKUP_ACTIONS.includes(action);
}

/**
 * Interface standardisée pour le validator
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidAction(action) {
  return isValidBackupAction(action);
}

/**
 * Valide les paramètres d'une action Backup
 * @param {string} action - Action Backup
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateBackupParams(action, params) {
  return validateParams(action, params);
}

/**
 * Interface standardisée pour la validation des paramètres
 * @param {string} action - Action Backup
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateParams(action, params) {
  switch (action) {
    case "toggle-logs-backup": {
      if (!params || typeof params !== "object") {
        throw new Error("Les paramètres doivent être un objet");
      }

      // Validation enabled
      if (typeof params.enabled !== "boolean") {
        throw new Error("enabled est requis et doit être un booléen");
      }

      // Validation awsAccessKeyId (requis si enabled = true)
      if (params.enabled) {
        if (!params.awsAccessKeyId || typeof params.awsAccessKeyId !== "string") {
          throw new Error(
            "awsAccessKeyId est requis et doit être une chaîne de caractères"
          );
        }
        if (!params.awsAccessKeyId.trim()) {
          throw new Error("awsAccessKeyId ne peut pas être vide");
        }

        // Validation awsSecretAccessKey
        if (!params.awsSecretAccessKey || typeof params.awsSecretAccessKey !== "string") {
          throw new Error(
            "awsSecretAccessKey est requis et doit être une chaîne de caractères"
          );
        }
        if (!params.awsSecretAccessKey.trim()) {
          throw new Error("awsSecretAccessKey ne peut pas être vide");
        }

        // Validation awsRegion
        if (!params.awsRegion || typeof params.awsRegion !== "string") {
          throw new Error(
            "awsRegion est requis et doit être une chaîne de caractères"
          );
        }
        if (!params.awsRegion.trim()) {
          throw new Error("awsRegion ne peut pas être vide");
        }

        // Validation awsLogsBucket
        if (!params.awsLogsBucket || typeof params.awsLogsBucket !== "string") {
          throw new Error(
            "awsLogsBucket est requis et doit être une chaîne de caractères"
          );
        }
        if (!params.awsLogsBucket.trim()) {
          throw new Error("awsLogsBucket ne peut pas être vide");
        }

        // Validation env (optionnel, défaut: prod)
        const env = params.env && typeof params.env === "string" 
          ? params.env.trim() 
          : "prod";
        
        if (!["dev", "sandbox", "prod"].includes(env)) {
          throw new Error("env doit être 'dev', 'sandbox' ou 'prod'");
        }

        return {
          enabled: true,
          awsAccessKeyId: params.awsAccessKeyId.trim(),
          awsSecretAccessKey: params.awsSecretAccessKey.trim(),
          awsRegion: params.awsRegion.trim(),
          awsLogsBucket: params.awsLogsBucket.trim(),
          env,
        };
      }

      // Si désactivation, pas besoin des paramètres AWS
      return {
        enabled: false,
      };
    }
    default:
      return params;
  }
}
