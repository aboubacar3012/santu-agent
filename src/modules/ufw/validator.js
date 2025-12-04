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
const ALLOWED_UFW_ACTIONS = ["list", "apply"];

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
    case "apply":
      // Valider que commands est un tableau
      if (!params || typeof params !== "object") {
        throw new Error("Les paramètres doivent être un objet");
      }
      if (!Array.isArray(params.commands)) {
        throw new Error("Le paramètre 'commands' doit être un tableau");
      }
      if (params.commands.length === 0) {
        throw new Error("Le tableau 'commands' ne peut pas être vide");
      }
      if (params.commands.length > 50) {
        throw new Error(
          "Le nombre maximum de commandes est limité à 50 pour des raisons de sécurité"
        );
      }
      // Valider chaque commande
      const validatedCommands = params.commands.map((cmd, index) => {
        if (typeof cmd !== "string") {
          throw new Error(
            `La commande à l'index ${index} doit être une chaîne de caractères`
          );
        }
        const trimmedCmd = cmd.trim();
        if (!trimmedCmd) {
          throw new Error(
            `La commande à l'index ${index} ne peut pas être vide`
          );
        }
        // Vérifier que la commande commence par "ufw" ou "sudo ufw" (sécurité)
        const normalizedCmd = trimmedCmd.toLowerCase();
        if (
          !normalizedCmd.startsWith("ufw ") &&
          !normalizedCmd.startsWith("sudo ufw ")
        ) {
          throw new Error(
            `La commande à l'index ${index} doit commencer par "ufw" ou "sudo ufw"`
          );
        }
        return trimmedCmd;
      });
      return { commands: validatedCommands };
    default:
      return params;
  }
}

