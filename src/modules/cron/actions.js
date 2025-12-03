/**
 * Actions Cron pour l'agent.
 *
 * Ce module encapsule toutes les opérations autorisées sur les tâches cron afin de :
 * - centraliser la récupération des tâches cron du serveur,
 * - parser les différents formats de crontab,
 * - fournir des réponses formatées prêtes à être envoyées via WebSocket.
 *
 * @module modules/cron/actions
 */

import { logger } from "../../shared/logger.js";
import { executeCommand } from "../../shared/executor.js";
import { validateCronParams } from "./validator.js";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Parse une ligne de crontab
 * @param {string} line - Ligne de crontab
 * @param {string} user - Utilisateur propriétaire (optionnel, sera extrait si présent dans la ligne)
 * @param {string} source - Fichier source
 * @returns {Object|null} Tâche cron parsée ou null si invalide
 */
function parseCronLine(line, user, source) {
  // Nettoyer la ligne
  const cleaned = line.trim();

  // Ignorer les lignes vides et les commentaires
  if (!cleaned || cleaned.startsWith("#")) {
    return null;
  }

  // Format crontab système : "minute hour day month weekday user command"
  // Format crontab utilisateur : "minute hour day month weekday command"
  const parts = cleaned.split(/\s+/);

  let minute, hour, day, month, weekday, command, finalUser;

  if (parts.length >= 6 && source === "/etc/crontab") {
    // Format système avec user dans la ligne
    [minute, hour, day, month, weekday, finalUser, ...commandParts] = parts;
    command = commandParts.join(" ");
  } else if (parts.length >= 5) {
    // Format utilisateur sans user explicite dans la ligne
    [minute, hour, day, month, weekday, ...commandParts] = parts;
    command = commandParts.join(" ");
    finalUser = user || "root";
  } else {
    // Ligne invalide
    return null;
  }

  if (!command || !command.trim()) {
    return null;
  }

  return {
    schedule: {
      minute: minute || "*",
      hour: hour || "*",
      day: day || "*",
      month: month || "*",
      weekday: weekday || "*",
    },
    command: command.trim(),
    user: finalUser || user || "root",
    source: source,
    enabled: true,
  };
}

/**
 * Récupère les tâches cron système depuis /etc/crontab
 * @returns {Promise<Array<Object>>} Liste des tâches cron système
 */
async function getSystemCronJobs() {
  const crontabPath = "/etc/crontab";
  const jobs = [];

  if (!existsSync(crontabPath)) {
    logger.debug("/etc/crontab n'existe pas");
    return jobs;
  }

  try {
    const content = readFileSync(crontabPath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();

      // Ignorer les commentaires et lignes vides
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      // Parser la ligne directement (parseCronLine gère le format système)
      const parsed = parseCronLine(trimmed, null, crontabPath);
      if (parsed) {
        jobs.push(parsed);
      }
    }
  } catch (error) {
    logger.error("Erreur lors de la lecture de /etc/crontab", {
      error: error.message,
    });
  }

  return jobs;
}

/**
 * Récupère les tâches cron d'un utilisateur depuis son crontab
 * @param {string} username - Nom d'utilisateur
 * @returns {Promise<Array<Object>>} Liste des tâches cron de l'utilisateur
 */
async function getUserCronJobs(username) {
  const jobs = [];

  try {
    // Essayer d'utiliser crontab -l pour récupérer le crontab de l'utilisateur
    const { stdout, stderr, error } = await executeCommand(
      `crontab -l -u ${username} 2>/dev/null || echo ""`,
      { timeout: 5000 }
    );

    if (error && !stderr.includes("no crontab")) {
      logger.debug(
        `Erreur lors de la récupération du crontab pour ${username}`,
        {
          error: stderr,
        }
      );
      return jobs;
    }

    if (stdout && stdout.trim()) {
      const lines = stdout.split("\n");
      for (const line of lines) {
        const parsed = parseCronLine(
          line,
          username,
          `/var/spool/cron/crontabs/${username}`
        );
        if (parsed) {
          jobs.push(parsed);
        }
      }
    }
  } catch (error) {
    logger.debug(`Erreur lors de la récupération du crontab pour ${username}`, {
      error: error.message,
    });
  }

  return jobs;
}

/**
 * Récupère la liste des utilisateurs système
 * @returns {Promise<Array<string>>} Liste des utilisateurs
 */
async function getSystemUsers() {
  try {
    // Utiliser getent passwd pour obtenir tous les utilisateurs
    const { stdout, stderr, error } = await executeCommand("getent passwd", {
      timeout: 10000,
    });

    if (error || stderr) {
      logger.warn("Erreur lors de la récupération des utilisateurs", {
        error: stderr,
      });
      // Fallback sur /etc/passwd
      try {
        const passwdContent = readFileSync("/etc/passwd", "utf-8");
        return passwdContent
          .split("\n")
          .filter((line) => line.trim() && !line.startsWith("#"))
          .map((line) => line.split(":")[0]);
      } catch (fallbackError) {
        logger.error("Impossible de lire /etc/passwd", {
          error: fallbackError.message,
        });
        return [];
      }
    }

    return stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.split(":")[0])
      .filter((user) => user);
  } catch (error) {
    logger.error("Erreur lors de la récupération des utilisateurs", {
      error: error.message,
    });
    return [];
  }
}

/**
 * Récupère les tâches cron depuis les fichiers dans /var/spool/cron/crontabs/
 * @returns {Promise<Array<Object>>} Liste des tâches cron utilisateurs
 */
async function getUserCronJobsFromFiles() {
  const jobs = [];
  const crontabsDir = "/var/spool/cron/crontabs";

  if (!existsSync(crontabsDir)) {
    logger.debug("/var/spool/cron/crontabs n'existe pas");
    return jobs;
  }

  try {
    const files = readdirSync(crontabsDir);
    for (const file of files) {
      // Ignorer les fichiers cachés et spéciaux
      if (file.startsWith(".")) {
        continue;
      }

      const filePath = join(crontabsDir, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        for (const line of lines) {
          const parsed = parseCronLine(line, file, filePath);
          if (parsed) {
            jobs.push(parsed);
          }
        }
      } catch (error) {
        logger.debug(`Erreur lors de la lecture de ${filePath}`, {
          error: error.message,
        });
      }
    }
  } catch (error) {
    logger.error("Erreur lors de la lecture de /var/spool/cron/crontabs", {
      error: error.message,
    });
  }

  return jobs;
}

/**
 * Liste toutes les tâches cron du serveur
 * @param {Object} params - Paramètres (non utilisés pour l'instant)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Array>} Liste de toutes les tâches cron trouvées
 */
export async function listCronJobs(params = {}, callbacks = {}) {
  try {
    validateCronParams("list", params);

    logger.debug("Début de la récupération des tâches cron");

    const allJobs = [];

    // 1. Récupérer les tâches cron système depuis /etc/crontab
    const systemJobs = await getSystemCronJobs();
    allJobs.push(...systemJobs);
    logger.debug(`Trouvé ${systemJobs.length} tâches cron système`);

    // 2. Récupérer les tâches cron utilisateurs depuis /var/spool/cron/crontabs/
    const userJobsFromFiles = await getUserCronJobsFromFiles();
    allJobs.push(...userJobsFromFiles);
    logger.debug(
      `Trouvé ${userJobsFromFiles.length} tâches cron utilisateurs depuis les fichiers`
    );

    // 3. Essayer aussi avec crontab -l pour chaque utilisateur (fallback)
    const users = await getSystemUsers();
    logger.debug(`Traitement de ${users.length} utilisateurs`);

    for (const username of users) {
      try {
        const userJobs = await getUserCronJobs(username);
        if (userJobs.length > 0) {
          // Vérifier si ces jobs ne sont pas déjà dans la liste (éviter les doublons)
          for (const job of userJobs) {
            const isDuplicate = allJobs.some(
              (existingJob) =>
                existingJob.command === job.command &&
                existingJob.user === job.user &&
                existingJob.schedule.minute === job.schedule.minute &&
                existingJob.schedule.hour === job.schedule.hour &&
                existingJob.schedule.day === job.schedule.day &&
                existingJob.schedule.month === job.schedule.month &&
                existingJob.schedule.weekday === job.schedule.weekday
            );
            if (!isDuplicate) {
              allJobs.push(job);
            }
          }
        }
      } catch (error) {
        logger.debug("Erreur lors du traitement de l'utilisateur", {
          username,
          error: error.message,
        });
      }
    }

    logger.info(
      `Récupération terminée : ${allJobs.length} tâches cron trouvées`
    );

    return allJobs;
  } catch (error) {
    logger.error("Erreur lors de la récupération des tâches cron", {
      error: error.message,
    });
    throw error;
  }
}
