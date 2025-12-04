/**
 * Actions UFW pour l'agent.
 *
 * Ce module encapsule toutes les opérations autorisées pour récupérer
 * les règles de pare-feu UFW.
 *
 * @module modules/ufw/actions
 */

import { logger } from "../../shared/logger.js";
import { executeCommand } from "../../shared/executor.js";
import { validateUfwParams } from "./validator.js";

/**
 * Extrait le statut UFW depuis la sortie de la commande
 * @param {string} output - Sortie complète de la commande
 * @returns {string} Statut ("active" ou "inactive")
 */
function extractUfwStatus(output) {
  if (!output || typeof output !== "string") {
    return "unknown";
  }

  const lines = output.split("\n");
  for (const line of lines) {
    const cleaned = line.trim();
    if (cleaned.startsWith("Status:")) {
      const statusMatch = cleaned.match(/Status:\s*(active|inactive)/i);
      if (statusMatch && statusMatch[1]) {
        return statusMatch[1].toLowerCase();
      }
    }
  }

  return "unknown";
}

/**
 * Parse une ligne de règle UFW
 * Format attendu: [ 1] 22/tcp                     ALLOW IN    Anywhere
 * ou: [ 4] 22/tcp (v6)                ALLOW IN    Anywhere (v6)
 * @param {string} line - Ligne à parser
 * @returns {Object|null} Règle parsée ou null si la ligne n'est pas une règle valide
 */
function parseUfwStatusLine(line) {
  if (!line || typeof line !== "string") {
    return null;
  }

  const cleaned = line.trim();

  // Ignorer les lignes vides, les en-têtes et les lignes qui ne commencent pas par [
  if (
    !cleaned ||
    cleaned.startsWith("To") ||
    cleaned.startsWith("--") ||
    !cleaned.startsWith("[")
  ) {
    return null;
  }

  // Regex pour extraire: [numéro] port/protocole action direction source
  // Format: [ 1] 22/tcp                     ALLOW IN    Anywhere
  // ou: [ 4] 22/tcp (v6)                ALLOW IN    Anywhere (v6)
  // Les colonnes sont séparées par des espaces multiples, donc on utilise \s+
  const ruleMatch = cleaned.match(
    /\[\s*(\d+)\]\s+([^\s]+(?:\s+\(v6\))?)\s+(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT)\s+(.+)$/
  );

  if (!ruleMatch || ruleMatch.length < 6) {
    // Essayer une approche alternative avec split sur espaces multiples
    // Format: [ 1] 22/tcp                     ALLOW IN    Anywhere
    const parts = cleaned.split(/\s{2,}/);
    if (parts.length >= 4 && cleaned.startsWith("[")) {
      const numberMatch = cleaned.match(/\[\s*(\d+)\]/);
      if (numberMatch) {
        const number = parseInt(numberMatch[1], 10);
        if (!isNaN(number) && number >= 1) {
          // parts[0] = "[ 1] 22/tcp" ou "[ 4] 22/tcp (v6)"
          const firstPart = parts[0].replace(/\[\s*\d+\]\s*/, "").trim();
          let port = firstPart;
          let ipv6 = false;
          
          if (port.includes("(v6)")) {
            ipv6 = true;
            port = port.replace(/\s*\(v6\)/g, "").trim();
          }

          const action = parts[1]?.trim() || "";
          const direction = parts[2]?.trim() || "";
          let source = parts.slice(3).join(" ").trim();

          if (source.includes("(v6)")) {
            ipv6 = true;
            source = source.replace(/\s*\(v6\)/g, "").trim();
          }

          if (action && direction && port) {
            return {
              number,
              port,
              action,
              direction,
              source: source || "Anywhere",
              ipv6,
            };
          }
        }
      }
    }
    return null;
  }

  const number = parseInt(ruleMatch[1], 10);
  let port = ruleMatch[2].trim();
  const action = ruleMatch[3].trim();
  const direction = ruleMatch[4].trim();
  let source = ruleMatch[5].trim();

  // Détecter IPv6
  let ipv6 = false;
  if (port.includes("(v6)") || source.includes("(v6)")) {
    ipv6 = true;
    port = port.replace(/\s*\(v6\)/g, "").trim();
    source = source.replace(/\s*\(v6\)/g, "").trim();
  }

  // Valider que le numéro est valide
  if (isNaN(number) || number < 1) {
    return null;
  }

  return {
    number,
    port,
    action,
    direction,
    source,
    ipv6,
  };
}

/**
 * Liste toutes les règles UFW
 * @param {Object} params - Paramètres (non utilisés pour l'instant)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Objet contenant le statut et les règles
 */
export async function listUfwRules(params = {}, callbacks = {}) {
  try {
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

