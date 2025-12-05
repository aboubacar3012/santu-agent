/**
 * Action list - Liste toutes les tâches cron du serveur
 *
 * @module modules/cron/actions/list
 */

import { logger } from "../../../shared/logger.js";
import { executeCommand } from "../../../shared/executor.js";
import { validateCronParams } from "../validator.js";
import { readFileSync, existsSync } from "fs";
import {
  parseCronLine,
  getSystemCronJobs,
  getUserCronJobs,
  getSystemUsers,
  getAllCronJobsViaCommand,
} from "./utils.js";

/**
 * Liste toutes les tâches cron du serveur
 * @param {Object} params - Paramètres (non utilisés pour l'instant)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Array>} Liste de toutes les tâches cron trouvées
 */
export async function listCronJobs(params = {}, callbacks = {}) {
  try {
    validateCronParams("list", params);

    logger.info("Début de la récupération des tâches cron");

    const allJobs = [];

    // 1. Récupérer les tâches cron système depuis /etc/crontab
    logger.debug("Étape 1: Lecture de /etc/crontab");
    const systemJobs = await getSystemCronJobs();
    allJobs.push(...systemJobs);
    logger.info(`Trouvé ${systemJobs.length} tâches cron système`);

    // 2. Récupérer tous les utilisateurs système (comme dans SSH)
    logger.debug("Étape 2: Récupération de tous les utilisateurs système");
    const users = await getSystemUsers();
    logger.info(`Trouvé ${users.length} utilisateurs à traiter`);

    // 3. Parcourir chaque utilisateur pour récupérer ses tâches cron
    logger.debug("Étape 3: Parcours de tous les utilisateurs");
    for (const username of users) {
      try {
        // Essayer d'abord de lire directement depuis les fichiers
        const possiblePaths = [
          `/var/spool/cron/crontabs/${username}`,
          `/var/spool/cron/${username}`,
        ];

        let userJobs = [];

        // Essayer de lire depuis les fichiers
        for (const filePath of possiblePaths) {
          if (existsSync(filePath)) {
            try {
              const content = readFileSync(filePath, "utf-8");
              const lines = content.split("\n");
              logger.debug(
                `Lecture de ${filePath}: ${lines.length} lignes pour ${username}`
              );

              for (const line of lines) {
                const parsed = parseCronLine(line, username, filePath);
                if (parsed) {
                  logger.debug(
                    `Tâche cron parsée depuis fichier pour ${username}: ${parsed.command.substring(
                      0,
                      50
                    )}...`
                  );
                  userJobs.push(parsed);
                }
              }
              break; // Si on a trouvé et lu le fichier, pas besoin d'essayer les autres
            } catch (error) {
              logger.debug(`Erreur lors de la lecture de ${filePath}`, {
                error: error.message,
                code: error.code,
              });
              // Si permission denied, essayer avec sudo cat
              if (
                error.code === "EACCES" ||
                error.message.includes("permission denied") ||
                error.message.includes("EACCES")
              ) {
                try {
                  logger.debug(`Tentative avec sudo cat pour ${filePath}`);
                  const { stdout } = await executeCommand(
                    `sudo cat ${filePath}`,
                    { timeout: 5000 }
                  );
                  if (stdout && stdout.trim()) {
                    const lines = stdout.split("\n");
                    logger.debug(
                      `Lecture avec sudo réussie: ${lines.length} lignes`
                    );
                    for (const line of lines) {
                      const parsed = parseCronLine(line, username, filePath);
                      if (parsed) {
                        logger.debug(
                          `Tâche cron parsée avec sudo pour ${username}: ${parsed.command.substring(
                            0,
                            50
                          )}...`
                        );
                        userJobs.push(parsed);
                      }
                    }
                    break;
                  }
                } catch (sudoError) {
                  logger.debug(`Erreur avec sudo cat pour ${filePath}`, {
                    error: sudoError.message,
                  });
                }
              }
            }
          }
        }

        // Si aucun fichier trouvé, essayer avec crontab -l
        if (userJobs.length === 0) {
          const crontabJobs = await getUserCronJobs(username);
          userJobs.push(...crontabJobs);
        }

        // Ajouter les jobs trouvés (éviter les doublons)
        if (userJobs.length > 0) {
          logger.debug(`Trouvé ${userJobs.length} tâches pour ${username}`);
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
        // Continuer avec le prochain utilisateur
      }
    }

    // 4. Essayer aussi via commande système (fallback supplémentaire)
    if (allJobs.length === 0) {
      logger.debug("Étape 4: Tentative via commande système");
      const commandJobs = await getAllCronJobsViaCommand();
      allJobs.push(...commandJobs);
      logger.info(
        `Trouvé ${commandJobs.length} tâches cron via commande système`
      );
    }

    logger.info(
      `Récupération terminée : ${allJobs.length} tâches cron trouvées au total`
    );

    // Log de debug pour voir quelques exemples
    if (allJobs.length > 0) {
      logger.debug("Exemples de tâches trouvées:", {
        examples: allJobs.slice(0, 3).map((j) => ({
          user: j.user,
          schedule: `${j.schedule.minute} ${j.schedule.hour} ${j.schedule.day} ${j.schedule.month} ${j.schedule.weekday}`,
          command: j.command.substring(0, 50),
        })),
      });
    } else {
      logger.warn(
        "Aucune tâche cron trouvée. Vérifiez les permissions et les emplacements des fichiers."
      );
    }

    return allJobs;
  } catch (error) {
    logger.error("Erreur lors de la récupération des tâches cron", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}
