/**
 * Action apply - Applique des règles UFW en exécutant une série de commandes
 *
 * @module modules/ufw/actions/apply
 */

import { logger } from "../../../shared/logger.js";
import { validateUfwParams } from "../validator.js";
import {
  cleanUfwCommand,
  prepareUfwCommand,
  findDenyAnywhereRuleNumber,
  executeUfwCommand,
  isAddCommand,
} from "./utils.js";

/**
 * Applique des règles UFW en exécutant une série de commandes
 * Pour éviter que les nouvelles règles se retrouvent en bas, on supprime
 * temporairement la règle "deny anywhere" avant d'ajouter, puis on la réajoute après.
 * @param {Object} params - Paramètres contenant les commandes à exécuter
 * @param {string[]} params.commands - Tableau de commandes UFW à exécuter
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Résultats de l'exécution de chaque commande
 */
export async function applyUfwRules(params = {}, callbacks = {}) {
  try {
    validateUfwParams("apply", params);

    const { commands } = params;
    logger.debug("Début de l'application des règles UFW", {
      commandCount: commands.length,
    });

    // Détecter si on a des commandes d'ajout (allow/deny mais pas delete)
    const hasAddCommands = commands.some((cmd) => isAddCommand(cmd));

    // Si on ajoute des règles, trouver et supprimer temporairement "deny anywhere"
    let denyAnywhereNumber = null;
    if (hasAddCommands) {
      denyAnywhereNumber = await findDenyAnywhereRuleNumber();
      if (denyAnywhereNumber !== null) {
        logger.debug(
          `Règle deny anywhere trouvée (numéro ${denyAnywhereNumber}), suppression temporaire`
        );
        const deleteCommand = `ufw --force delete ${denyAnywhereNumber}`;
        const deleteResult = await executeUfwCommand(deleteCommand);
        if (deleteResult.error) {
          logger.warn(
            "Impossible de supprimer temporairement la règle deny anywhere",
            {
              error: deleteResult.error.message || deleteResult.error,
              stderr: deleteResult.stderr,
            }
          );
          // Continuer quand même, ce n'est pas bloquant
        }
      }
    }

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
        const hasError =
          result.error || (result.stderr && result.stderr.includes("ERROR:"));
        const errorMessage = result.error
          ? result.error.message || String(result.error)
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

    // Si on avait supprimé "deny anywhere", la réajouter à la fin
    if (denyAnywhereNumber !== null && hasAddCommands) {
      logger.debug("Réajout de la règle deny anywhere à la fin");
      const denyCommand = "ufw deny from any to any";
      const denyResult = await executeUfwCommand(denyCommand);

      if (denyResult.error) {
        logger.warn("Impossible de réajouter la règle deny anywhere", {
          error: denyResult.error.message || denyResult.error,
          stderr: denyResult.stderr,
        });
        // Ajouter le résultat même en cas d'échec pour traçabilité
        results.push({
          command: `[Auto] ${denyCommand}`,
          success: false,
          stdout: denyResult.stdout || "",
          stderr: denyResult.stderr || "",
          error: denyResult.error
            ? denyResult.error.message || String(denyResult.error)
            : null,
        });
      } else {
        logger.debug("Règle deny anywhere réajoutée avec succès");
        results.push({
          command: `[Auto] ${denyCommand}`,
          success: true,
          stdout: denyResult.stdout || "",
          stderr: denyResult.stderr || "",
          error: null,
        });
      }
    }

    // Compter les succès et échecs
    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    logger.info(
      `Application des règles UFW terminée : ${successCount} succès, ${failureCount} échecs`
    );

    return {
      success: failureCount === 0, // Succès global si toutes les commandes ont réussi
      results,
    };
  } catch (error) {
    logger.error("Erreur lors de l'application des règles UFW", {
      error: error.message,
    });
    throw error;
  }
}

