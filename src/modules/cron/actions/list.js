/**
 * Action list - Liste toutes les tâches cron du serveur
 *
 * @module modules/cron/actions/list
 */

import { logger } from "../../../shared/logger.js";
import { validateCronParams } from "../validator.js";
import { executeHostCommand } from "./utils.js";

/**
 * Parse un fichier cron personnalisé créé via add-cron
 * Format attendu:
 * # description (optionnel)
 * # minute hour day month weekday user command (si enabled=false)
 * minute hour day month weekday user command (si enabled=true)
 * @param {string} content - Contenu du fichier
 * @param {string} filePath - Chemin du fichier
 * @returns {Object|null} Tâche cron parsée ou null
 */
function parseCustomCronFile(content, filePath) {
  const lines = content.split("\n");
  let description = null;
  let cronLine = null;
  let enabled = true;
  let firstNonEmptyLineFound = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Ignorer les lignes vides jusqu'à trouver la première ligne non vide
    if (!trimmed) {
      continue;
    }

    // Si on a déjà trouvé la ligne cron, on arrête
    if (cronLine) {
      break;
    }

    // Si c'est la première ligne non vide du fichier
    if (!firstNonEmptyLineFound) {
      firstNonEmptyLineFound = true;

      // Vérifier si c'est un commentaire de description (pas une ligne cron commentée)
      if (trimmed.startsWith("#") && !trimmed.match(/^#\s*[\d\*\/\-\,\s]+/)) {
        // C'est une description sur la première ligne
        const descMatch = trimmed.match(/^#\s*(.+)$/);
        if (descMatch) {
          description = descMatch[1].trim();
        }
        continue; // Passer à la ligne suivante
      }
      // Si la première ligne n'est pas un commentaire de description,
      // elle doit être une ligne cron, on la traitera ci-dessous
    }

    // Ligne cron (active ou commentée)
    if (trimmed.startsWith("#")) {
      // Ligne cron commentée (tâche désactivée)
      const commentedLine = trimmed.substring(1).trim();
      if (commentedLine.match(/^[\d\*\/\-\,\s]+/)) {
        cronLine = commentedLine;
        enabled = false;
        break; // On a trouvé la ligne cron, on s'arrête
      }
    } else if (trimmed.match(/^[\d\*\/\-\,\s]+/)) {
      // Ligne cron active
      cronLine = trimmed;
      enabled = true;
      break; // On a trouvé la ligne cron, on s'arrête
    }
  }

  if (!cronLine) {
    return null;
  }

  // Parser la ligne cron (format: minute hour day month weekday user command)
  const parts = cronLine.split(/\s+/);
  if (parts.length < 6) {
    return null;
  }

  const [minute, hour, day, month, weekday, user, ...commandParts] = parts;
  const command = commandParts.join(" ");

  // Extraire le nom de la tâche depuis le nom du fichier (enlever "agent-cron-" et l'extension)
  const fileName = filePath.split("/").pop();
  const taskName = fileName
    .replace(/^agent-cron-/, "")
    .replace(/\.(cfg|conf)?$/, "");

  return {
    schedule: {
      minute: minute || "*",
      hour: hour || "*",
      day: day || "*",
      month: month || "*",
      weekday: weekday || "*",
    },
    command: command.trim(),
    user: user || "root",
    source: filePath,
    enabled: enabled,
    description: description || null,
    task_name: taskName,
    is_custom: true, // Marqueur pour identifier les tâches créées via add-cron
  };
}

/**
 * Récupère les tâches cron personnalisées depuis /etc/cron.d/
 * @returns {Promise<Array>} Liste des tâches cron personnalisées
 */
async function getCustomCronJobs() {
  const jobs = [];
  const cronDDir = "/etc/cron.d";

  try {
    // Vérifier si le répertoire existe
    const checkDirResult = await executeHostCommand(
      `test -d '${cronDDir}' && echo 'exists' || echo 'not_exists'`
    );
    if (checkDirResult.stdout.trim() !== "exists") {
      logger.debug("Le répertoire /etc/cron.d n'existe pas");
      return jobs;
    }

    // Lister tous les fichiers commençant par "agent-cron-"
    const listResult = await executeHostCommand(
      `ls -1 '${cronDDir}'/agent-cron-* 2>/dev/null || echo ''`
    );

    const files = listResult.stdout
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0);

    if (files.length === 0) {
      logger.debug("Aucun fichier agent-cron- trouvé dans /etc/cron.d/");
      return jobs;
    }

    // Lire et parser chaque fichier
    for (const filePath of files) {
      try {
        const readResult = await executeHostCommand(
          `cat '${filePath}' 2>/dev/null || echo ''`
        );
        const content = readResult.stdout || "";

        if (!content.trim()) {
          logger.debug(`Fichier vide: ${filePath}`);
          continue;
        }

        const parsed = parseCustomCronFile(content, filePath);
        if (parsed) {
          logger.debug(`Tâche cron personnalisée parsée: ${parsed.task_name}`);
          jobs.push(parsed);
        } else {
          logger.debug(`Impossible de parser le fichier: ${filePath}`);
        }
      } catch (error) {
        logger.warn(
          "Erreur lors de la lecture d'un fichier cron personnalisé",
          {
            filePath,
            error: error.message,
          }
        );
        continue;
      }
    }
  } catch (error) {
    logger.warn(
      "Erreur lors de la récupération des tâches cron personnalisées",
      {
        error: error.message,
      }
    );
  }

  return jobs;
}

/**
 * Liste uniquement les tâches cron créées via add-cron (fichiers agent-cron-* dans /etc/cron.d/)
 * @param {Object} params - Paramètres (non utilisés pour l'instant)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Array>} Liste des tâches cron personnalisées
 */
export async function listCronJobs(params = {}, callbacks = {}) {
  try {
    validateCronParams("list", params);

    logger.info(
      "Début de la récupération des tâches cron personnalisées (agent-cron-*)"
    );

    // Récupérer uniquement les tâches cron créées via add-cron
    const customCronJobs = await getCustomCronJobs();
    logger.info(
      `Récupération terminée : ${customCronJobs.length} tâches cron personnalisées trouvées`
    );

    // Log de debug pour voir quelques exemples
    if (customCronJobs.length > 0) {
      logger.debug("Exemples de tâches trouvées:", {
        examples: customCronJobs.slice(0, 3).map((j) => ({
          task_name: j.task_name,
          user: j.user,
          schedule: `${j.schedule.minute} ${j.schedule.hour} ${j.schedule.day} ${j.schedule.month} ${j.schedule.weekday}`,
          command: j.command.substring(0, 50),
          enabled: j.enabled,
        })),
      });
    } else {
      logger.debug("Aucune tâche cron personnalisée trouvée dans /etc/cron.d/");
    }

    return customCronJobs;
  } catch (error) {
    logger.error("Erreur lors de la récupération des tâches cron", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}
