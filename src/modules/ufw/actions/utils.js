/**
 * Utilitaires pour les actions UFW
 *
 * Fonctions partagées utilisées par plusieurs actions UFW.
 *
 * @module modules/ufw/actions/utils
 */

import { logger } from "../../../shared/logger.js";
import { executeCommand } from "../../../shared/executor.js";

/**
 * Extrait le statut UFW depuis la sortie de la commande
 * @param {string} output - Sortie complète de la commande
 * @returns {string} Statut ("active" ou "inactive")
 */
export function extractUfwStatus(output) {
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
export function parseUfwStatusLine(line) {
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
 * Nettoie une commande UFW en retirant "sudo" si présent
 * @param {string} command - Commande à nettoyer
 * @returns {string} Commande nettoyée
 */
export function cleanUfwCommand(command) {
  // Retirer "sudo" si présent au début
  return command.replace(/^sudo\s+/i, "").trim();
}

/**
 * Prépare une commande UFW pour l'exécution via nsenter avec gestion des confirmations
 * @param {string} command - Commande UFW à préparer
 * @returns {string} Commande préparée pour nsenter
 */
export function prepareUfwCommand(command) {
  const cleaned = cleanUfwCommand(command);
  
  // Pour les commandes "delete", ajouter --force pour éviter les confirmations
  if (cleaned.toLowerCase().includes("delete")) {
    // Si --force n'est pas déjà présent, l'ajouter après "ufw"
    if (!cleaned.toLowerCase().includes("--force")) {
      return cleaned.replace(/^ufw\s+/i, "ufw --force ");
    }
  }
  
  return cleaned;
}

/**
 * Trouve le numéro de la règle "deny anywhere" dans la liste des règles UFW
 * @returns {Promise<number|null>} Numéro de la règle ou null si non trouvée
 */
export async function findDenyAnywhereRuleNumber() {
  try {
    const nsenterCommand =
      "nsenter -t 1 -m -u -i -n -p -- sh -c 'ufw status numbered'";
    const result = await executeCommand(nsenterCommand, {
      timeout: 10000,
    });

    if (result.error || !result.stdout) {
      return null;
    }

    const lines = result.stdout.split("\n");
    for (const line of lines) {
      const rule = parseUfwStatusLine(line);
      if (
        rule &&
        rule.action === "DENY" &&
        (rule.source === "Anywhere" ||
          rule.source.toLowerCase().includes("anywhere"))
      ) {
        return rule.number;
      }
    }

    return null;
  } catch (error) {
    logger.debug("Erreur lors de la recherche de la règle deny anywhere", {
      error: error.message,
    });
    return null;
  }
}

/**
 * Exécute une commande UFW via nsenter
 * @param {string} command - Commande UFW à exécuter
 * @returns {Promise<Object>} Résultat de l'exécution
 */
export async function executeUfwCommand(command) {
  const escapedCommand = command.replace(/'/g, "'\"'\"'");
  const nsenterCommand = `nsenter -t 1 -m -u -i -n -p -- sh -c '${escapedCommand}'`;

  return await executeCommand(nsenterCommand, {
    timeout: 30000,
  });
}

/**
 * Vérifie si une commande est une commande d'ajout (allow/deny mais pas delete)
 * @param {string} command - Commande à vérifier
 * @returns {boolean} True si c'est une commande d'ajout
 */
export function isAddCommand(command) {
  const cleaned = cleanUfwCommand(command).toLowerCase();
  return (
    (cleaned.includes("allow") || cleaned.includes("deny")) &&
    !cleaned.includes("delete")
  );
}

