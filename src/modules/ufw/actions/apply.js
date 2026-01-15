/**
 * Action apply - Applique des règles UFW en exécutant une série de commandes
 *
 * @module modules/ufw/actions/apply
 */

import { logger } from "../../../shared/logger.js";
import { validateUfwParams } from "../validator.js";
import { prepareUfwCommand, executeUfwCommand } from "./utils.js";
import { requireRole } from "../../../websocket/auth.js";

/**
 * Applique des règles UFW en exécutant une série de commandes
 * @param {Object} params - Paramètres contenant les commandes à exécuter
 * @param {string[]} params.commands - Tableau de commandes UFW à exécuter
 * @param {Object} [callbacks] - Callbacks et contexte
 * @param {Object} [callbacks.context] - Contexte de la connexion (userId, etc.)
 * @param {string} [callbacks.context.userId] - ID de l'utilisateur authentifié
 * @returns {Promise<Object>} Résultats de l'exécution de chaque commande
 */
export async function applyUfwRules(params = {}, callbacks = {}) {
  try {
    // Vérifier les permissions : seuls ADMIN et OWNER peuvent appliquer des règles UFW
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER"],
      "appliquer des règles UFW"
    );

    validateUfwParams("apply", params);

    const { commands } = params;
    logger.debug("Début de l'application des règles UFW", {
      commandCount: commands.length,
    });

    const results = [];

    // Exécuter chaque commande séquentiellement
    for (let i = 0; i < commands.length; i++) {
      const originalCommand = commands[i];
      const preparedCommand = prepareUfwCommand(originalCommand);

      logger.debug(`Exécution de la commande ${i + 1}/${commands.length}`, {
        original: originalCommand,
        prepared: preparedCommand,
      });

      try {
        const result = await executeUfwCommand(preparedCommand);

        // UFW peut retourner un code de sortie 0 même en cas d'erreur
        // Il faut vérifier stderr pour détecter les erreurs UFW
        // result.error peut être true (booléen), "true" (string), ou un objet Error
        const hasError =
          result.error === true ||
          result.error === "true" ||
          result.error instanceof Error ||
          (result.stderr && result.stderr.includes("ERROR:"));
        const errorMessage =
          result.error instanceof Error
            ? result.error.message
            : result.error === true || result.error === "true"
            ? result.stderr && result.stderr.includes("ERROR:")
              ? result.stderr.trim()
              : "Erreur lors de l'exécution de la commande"
            : result.stderr && result.stderr.includes("ERROR:")
            ? result.stderr.trim()
            : null;

        results.push({
          command: originalCommand,
          success: !hasError,
          stdout: result.stdout || "",
          stderr: result.stderr || "",
          error: errorMessage,
        });

        // Si une commande échoue, logger mais continuer avec les autres
        if (hasError) {
          logger.warn(`La commande ${i + 1} a échoué`, {
            command: originalCommand,
            error: errorMessage,
            stderr: result.stderr,
          });
        } else {
          logger.debug(`Commande ${i + 1} exécutée avec succès`, {
            command: originalCommand,
            stdout: result.stdout?.substring(0, 200), // Limiter la taille du log
          });
        }
      } catch (error) {
        // Erreur lors de l'exécution de la commande
        logger.error(`Erreur lors de l'exécution de la commande ${i + 1}`, {
          command: originalCommand,
          error: error.message,
        });

        results.push({
          command: originalCommand,
          success: false,
          stdout: "",
          stderr: "",
          error: error.message || String(error),
        });
      }
    }

    // Filtrer les résultats pour ne retourner que les commandes utilisateur
    // (exclure les commandes automatiques comme "[Auto] ...")
    const userResults = results.filter((r) => !r.command.startsWith("[Auto]"));

    // Compter les succès et échecs uniquement sur les commandes utilisateur
    const successCount = userResults.filter((r) => r.success).length;
    const failureCount = userResults.filter((r) => !r.success).length;

    logger.info(
      `Application des règles UFW terminée : ${successCount} succès, ${failureCount} échecs`
    );

    return {
      success: failureCount === 0, // Succès global si toutes les commandes utilisateur ont réussi
      results: userResults, // Retourner uniquement les résultats des commandes utilisateur
    };
  } catch (error) {
    logger.error("Erreur lors de l'application des règles UFW", {
      error: error.message,
    });
    throw error;
  }
}

