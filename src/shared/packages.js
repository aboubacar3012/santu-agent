/**
 * Utilitaires pour la gestion des packages système
 *
 * Fonctions partagées pour gérer les packages apt/dpkg
 *
 * @module shared/packages
 */

import { logger } from "./logger.js";
import { executeCommand } from "./executor.js";

/**
 * Exécute une commande sur l'hôte via nsenter
 * @param {string} command - Commande à exécuter
 * @param {Object} [options] - Options d'exécution
 * @returns {Promise<Object>} Résultat de l'exécution
 */
async function executeHostCommand(command, options = {}) {
  const escapedCommand = command.replace(/'/g, "'\"'\"'");
  const nsenterCommand = `nsenter -t 1 -m -u -i -n -p -- sh -c '${escapedCommand}'`;

  return await executeCommand(nsenterCommand, {
    timeout: options.timeout || 120000, // 2 minutes par défaut
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
  });
}

/**
 * Vérifie et tue les processus apt/dpkg bloqués depuis plus de 10 minutes
 * @returns {Promise<boolean>} True si des processus ont été tués ou aucun processus bloqué trouvé
 */
export async function killStaleAptProcesses() {
  try {
    // Trouver les processus apt/dpkg actifs
    const psResult = await executeHostCommand(
      `ps aux | grep -E '[a]pt-get|[a]pt |[d]pkg|[u]nattended-upgrade' | awk '{print $2}' || echo ''`
    );

    const pids = psResult.stdout
      .trim()
      .split("\n")
      .filter((pid) => pid && /^\d+$/.test(pid.trim()));

    if (pids.length === 0) {
      return true; // Aucun processus trouvé
    }

    const STALE_THRESHOLD = 10 * 60; // 10 minutes en secondes
    let killedAny = false;

    for (const pid of pids) {
      try {
        // Vérifier si le processus existe encore
        const existsResult = await executeHostCommand(
          `test -d /proc/${pid} && echo 'exists' || echo 'not_exists'`
        );
        if (existsResult.stdout.trim() !== "exists") {
          continue; // Processus déjà terminé
        }

        // Récupérer le temps de démarrage du processus (en secondes depuis le boot)
        const statResult = await executeHostCommand(
          `cat /proc/${pid}/stat 2>/dev/null | awk '{print $22}' || echo ''`
        );
        const startTime = statResult.stdout.trim();

        // Récupérer le temps système (uptime en secondes)
        const uptimeResult = await executeHostCommand(
          `cat /proc/uptime 2>/dev/null | awk '{print int($1)}' || echo '0'`
        );
        const systemUptime =
          Number.parseInt(uptimeResult.stdout.trim(), 10) || 0;

        if (!startTime || systemUptime === 0) {
          continue; // Impossible de déterminer l'âge
        }

        // Calculer l'âge du processus en secondes
        const clockTick = 100; // Hz par défaut
        const processStartSeconds = Number.parseInt(startTime, 10) / clockTick;
        const processAge = systemUptime - processStartSeconds;

        // Récupérer la commande pour le log
        const cmdResult = await executeHostCommand(
          `cat /proc/${pid}/cmdline 2>/dev/null | tr '\\0' ' ' | head -c 100 || echo 'unknown'`
        );
        const command = cmdResult.stdout.trim() || "unknown";

        if (processAge > STALE_THRESHOLD) {
          logger.warn(
            `Processus apt/dpkg bloqué détecté (PID: ${pid}, durée: ${Math.round(
              processAge / 60
            )}min)`,
            { pid, command, ageSeconds: Math.round(processAge) }
          );

          // Essayer SIGTERM d'abord
          await executeHostCommand(`kill -TERM ${pid}`, { timeout: 5000 });
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Vérifier si le processus existe encore
          const stillExistsResult = await executeHostCommand(
            `test -d /proc/${pid} && echo 'exists' || echo 'not_exists'`
          );
          if (stillExistsResult.stdout.trim() === "exists") {
            // Envoyer SIGKILL
            logger.warn(`Envoi de SIGKILL au processus ${pid}`);
            await executeHostCommand(`kill -KILL ${pid}`, { timeout: 5000 });
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }

          killedAny = true;
          logger.info(`Processus ${pid} arrêté`);
        }
      } catch (error) {
        logger.debug(`Erreur lors de la vérification du processus ${pid}`, {
          error: error.message,
        });
      }
    }

    if (killedAny) {
      // Attendre un peu pour que les locks soient libérés
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    return true;
  } catch (error) {
    logger.error("Erreur lors de la vérification des processus apt/dpkg", {
      error: error.message,
    });
    return false;
  }
}
