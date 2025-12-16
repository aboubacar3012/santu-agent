/**
 * Action list - Liste toutes les règles UFW
 *
 * @module modules/ufw/actions/list
 */

import { logger } from "../../../shared/logger.js";
import { validateUfwParams } from "../validator.js";
import { executeCommand } from "../../../shared/executor.js";
import { extractUfwStatus, parseUfwStatusLine } from "./utils.js";
import { requireRole } from "../../../websocket/auth.js";

/**
 * Liste toutes les règles UFW
 * @param {Object} params - Paramètres (non utilisés pour l'instant)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Objet contenant le statut et les règles
 */
export async function listUfwRules(params = {}, callbacks = {}) {
  try {
    // Vérifier les permissions : seuls ADMIN et OWNER peuvent lister les règles UFW
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER"],
      "lister les règles UFW"
    );

    validateUfwParams("list", params);

    logger.debug("Début de la récupération des règles UFW");

    // Avec pid_mode: host et privileged: true, on peut utiliser nsenter
    // pour exécuter la commande dans l'espace de noms de l'hôte (PID 1)
    // Cela permet d'utiliser les binaires et bibliothèques de l'hôte
    let stdout, stderr, error;

    // Utiliser nsenter pour exécuter ufw dans l'espace de noms de l'hôte
    // nsenter -t 1 -m -u -i -n -p -- ufw status numbered
    // -t 1 : PID du processus init de l'hôte
    // -m : monter l'espace de noms
    // -u : user namespace
    // -i : IPC namespace
    // -n : network namespace
    // -p : PID namespace
    const nsenterCommand =
      "nsenter -t 1 -m -u -i -n -p -- sh -c 'ufw status numbered'";

    logger.debug("Exécution de la commande via nsenter", {
      command: nsenterCommand,
    });

    const result = await executeCommand(nsenterCommand, {
      timeout: 10000,
    });

    stdout = result.stdout;
    stderr = result.stderr;
    error = result.error;

    // Si nsenter échoue, essayer directement (au cas où on serait déjà dans le bon namespace)
    if (error && stderr && stderr.includes("nsenter")) {
      logger.debug("nsenter a échoué, tentative directe");
      const directResult = await executeCommand("ufw status numbered", {
        timeout: 10000,
      });
      stdout = directResult.stdout;
      stderr = directResult.stderr;
      error = directResult.error;
    }

    if (error) {
      // Vérifier si UFW n'est pas installé
      if (
        stderr &&
        (stderr.includes("ufw: command not found") ||
          stderr.includes("ufw: not found") ||
          stderr.includes("/usr/sbin/ufw: not found"))
      ) {
        logger.error("UFW n'est pas installé sur ce système ou non accessible");
        throw new Error(
          "UFW n'est pas installé sur ce système ou non accessible"
        );
      }

      logger.error("Erreur lors de l'exécution de la commande ufw status", {
        error: error.message || error,
        stderr,
      });
      throw new Error(
        `Erreur lors de la récupération des règles UFW: ${
          stderr || error.message || error
        }`
      );
    }

    if (!stdout || typeof stdout !== "string") {
      logger.warn("Sortie vide de la commande ufw status numbered");
      return {
        status: "unknown",
        rules: [],
      };
    }

    // Extraire le statut
    const status = extractUfwStatus(stdout);

    // Parser les règles
    const lines = stdout.split("\n");
    const rules = [];

    for (const line of lines) {
      const rule = parseUfwStatusLine(line);
      if (rule) {
        rules.push(rule);
      }
    }

    logger.info(
      `Récupération terminée : statut=${status}, ${rules.length} règles trouvées`
    );

    return {
      status,
      rules,
    };
  } catch (error) {
    logger.error("Erreur lors de la récupération des règles UFW", {
      error: error.message,
    });
    throw error;
  }
}

