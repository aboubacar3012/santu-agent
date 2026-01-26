/**
 * Utilitaires pour les actions Cron
 *
 * Fonctions partagées utilisées par les actions Cron.
 *
 * @module modules/cron/actions/utils
 */

import { logger } from "../../../shared/logger.js";
import { executeCommand } from "../../../shared/executor.js";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Parse une ligne de crontab
 * @param {string} line - Ligne de crontab
 * @param {string} user - Utilisateur propriétaire (optionnel, sera extrait si présent dans la ligne)
 * @param {string} source - Fichier source
 * @returns {Object|null} Tâche cron parsée ou null si invalide
 */
export function parseCronLine(line, user, source) {
  // Nettoyer la ligne
  const cleaned = line.trim();

  // Ignorer les lignes vides et les commentaires complets
  if (!cleaned || cleaned.startsWith("#")) {
    return null;
  }

  // Vérifier si c'est une ligne cron valide (doit commencer par un chiffre, *, /, ou -)
  // Format: minute hour day month weekday [user] command
  const cronPattern = /^[\d\*\/\-\,\s]+/;
  if (!cronPattern.test(cleaned)) {
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

  // Valider que les champs de schedule sont valides
  if (!minute || !hour || !day || !month || !weekday) {
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
export async function getSystemCronJobs() {
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
export async function getUserCronJobs(username) {
  const jobs = [];

  try {
    // Essayer d'utiliser crontab -l pour récupérer le crontab de l'utilisateur
    // Essayer d'abord avec sudo crontab -l -u (nécessite root)
    let command = `sudo crontab -l -u ${username} 2>/dev/null || crontab -l -u ${username} 2>/dev/null || echo ""`;
    let { stdout, stderr, error } = await executeCommand(command, {
      timeout: 5000,
    });

    // Si ça échoue, essayer sans -u si c'est l'utilisateur courant
    if (
      (error || !stdout || stdout.includes("no crontab")) &&
      stderr &&
      !stderr.includes("no crontab")
    ) {
      logger.debug(`Tentative sans -u pour ${username}`, { error: stderr });
      command = `crontab -l 2>/dev/null || echo ""`;
      const result = await executeCommand(command, { timeout: 5000 });
      stdout = result.stdout;
      stderr = result.stderr;
      error = result.error;
    }

    if (
      error &&
      stderr &&
      !stderr.includes("no crontab") &&
      !stderr.includes("must be run")
    ) {
      logger.debug(
        `Erreur lors de la récupération du crontab pour ${username}`,
        {
          error: stderr,
        }
      );
      return jobs;
    }

    if (stdout && stdout.trim() && !stdout.includes("no crontab")) {
      const lines = stdout.split("\n");
      logger.debug(`Trouvé ${lines.length} lignes pour ${username}`);

      for (const line of lines) {
        const parsed = parseCronLine(
          line,
          username,
          `/var/spool/cron/crontabs/${username}`
        );
        if (parsed) {
          logger.debug(
            `Tâche cron parsée pour ${username}: ${parsed.command.substring(
              0,
              50
            )}...`
          );
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
export async function getSystemUsers() {
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
 * Récupère les tâches cron depuis les fichiers dans /var/spool/cron/
 * Supporte plusieurs formats selon la distribution Linux
 * @returns {Promise<Array<Object>>} Liste des tâches cron utilisateurs
 */
export async function getUserCronJobsFromFiles() {
  const jobs = [];

  // Essayer plusieurs emplacements possibles selon la distribution
  const possibleDirs = [
    "/var/spool/cron/crontabs", // Debian/Ubuntu
    "/var/spool/cron", // CentOS/RHEL
  ];

  for (const crontabsDir of possibleDirs) {
    if (!existsSync(crontabsDir)) {
      logger.debug(`${crontabsDir} n'existe pas`);
      continue;
    }

    try {
      const files = readdirSync(crontabsDir);
      logger.debug(`Lecture de ${files.length} fichiers dans ${crontabsDir}`);

      for (const file of files) {
        // Ignorer les fichiers cachés et spéciaux
        if (file.startsWith(".")) {
          continue;
        }

        const filePath = join(crontabsDir, file);
        try {
          const content = readFileSync(filePath, "utf-8");
          const lines = content.split("\n");
          logger.debug(`Lecture de ${filePath}: ${lines.length} lignes`);

          for (const line of lines) {
            const parsed = parseCronLine(line, file, filePath);
            if (parsed) {
              logger.debug(
                `Tâche cron parsée: ${parsed.command.substring(0, 50)}...`
              );
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
      logger.debug(`Erreur lors de la lecture de ${crontabsDir}`, {
        error: error.message,
      });
    }
  }

  return jobs;
}

/**
 * Récupère toutes les tâches cron en utilisant la commande système
 * @returns {Promise<Array<Object>>} Liste des tâches cron
 */
export async function getAllCronJobsViaCommand() {
  const jobs = [];

  try {
    // Essayer d'utiliser une commande qui liste toutes les tâches cron
    // Sur certains systèmes, on peut utiliser 'crontab -l' pour root qui liste tout
    const { stdout, stderr, error } = await executeCommand(
      `for user in $(cut -f1 -d: /etc/passwd); do crontab -l -u "$user" 2>/dev/null | grep -v "^#" | grep -v "^$" | sed "s|^|$user |"; done`,
      { timeout: 10000 }
    );

    if (error && stderr && !stderr.includes("no crontab")) {
      logger.debug("Erreur lors de la récupération via commande", {
        error: stderr,
      });
      return jobs;
    }

    if (stdout && stdout.trim()) {
      const lines = stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Format: "user minute hour day month weekday command"
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 6) {
          const [user, ...cronParts] = parts;
          const cronLine = cronParts.join(" ");
          const parsed = parseCronLine(
            cronLine,
            user,
            `/var/spool/cron/crontabs/${user}`
          );
          if (parsed) {
            jobs.push(parsed);
          }
        }
      }
    }
  } catch (error) {
    logger.debug("Erreur lors de la récupération via commande", {
      error: error.message,
    });
  }

  return jobs;
}

/**
 * Exécute une commande sur l'hôte via nsenter
 * @param {string} command - Commande à exécuter
 * @param {Object} [options] - Options d'exécution
 * @returns {Promise<Object>} Résultat de l'exécution
 */
export async function executeHostCommand(command, options = {}) {
  const escapedCommand = command.replace(/'/g, "'\"'\"'");
  const nsenterCommand = `nsenter -t 1 -m -u -i -n -p -- sh -c '${escapedCommand}'`;

  return await executeCommand(nsenterCommand, {
    timeout: options.timeout || 120000, // 2 minutes par défaut
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
  });
}

/**
 * Vérifie si un fichier existe sur l'hôte
 * @param {string} filePath - Chemin du fichier
 * @returns {Promise<boolean>} True si le fichier existe
 */
export async function hostFileExists(filePath) {
  try {
    const result = await executeHostCommand(
      `test -f '${filePath}' && echo 'exists' || echo 'not_exists'`
    );
    return result.stdout.trim() === "exists";
  } catch {
    return false;
  }
}

/**
 * Vérifie et installe cron si nécessaire
 * S'assure que le service cron est installé et en cours d'exécution
 * @returns {Promise<void>}
 */
export async function ensureCronInstalled() {
  try {
    // 1. Vérifier si cron est installé
    logger.debug("Vérification de l'installation de cron");
    const cronCheck = await executeHostCommand(
      "which cron 2>/dev/null || which crond 2>/dev/null || echo 'not_found'",
      { timeout: 5000 }
    );

    const cronInstalled = cronCheck.stdout.trim() !== "not_found";

    // 2. Vérifier si le service cron est en cours d'exécution
    let cronRunning = false;
    if (cronInstalled) {
      // Essayer systemctl d'abord (systemd)
      const systemctlCheck = await executeHostCommand(
        "systemctl is-active cron 2>/dev/null || systemctl is-active crond 2>/dev/null || echo 'inactive'",
        { timeout: 5000 }
      );

      if (systemctlCheck.stdout.trim() === "active") {
        cronRunning = true;
        logger.debug("Service cron est actif (systemd)");
      } else {
        // Essayer service (init.d)
        const serviceCheck = await executeHostCommand(
          "service cron status 2>/dev/null || service crond status 2>/dev/null || echo 'inactive'",
          { timeout: 5000 }
        );

        if (
          serviceCheck.stdout.includes("running") ||
          serviceCheck.stdout.includes("active")
        ) {
          cronRunning = true;
          logger.debug("Service cron est actif (init.d)");
        } else {
          // Vérifier si le processus cron tourne
          const processCheck = await executeHostCommand(
            "pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1 || echo 'not_running'",
            { timeout: 5000 }
          );

          if (processCheck.stdout.trim() !== "not_running") {
            cronRunning = true;
            logger.debug("Processus cron est en cours d'exécution");
          }
        }
      }
    }

    // 3. Si cron n'est pas installé, l'installer
    if (!cronInstalled) {
      logger.info("Installation de cron...");

      // Détecter la distribution
      const distroCheck = await executeHostCommand(
        "cat /etc/os-release 2>/dev/null | grep -i '^ID=' | cut -d'=' -f2 | tr -d '\"' || echo 'unknown'",
        { timeout: 5000 }
      );
      const distro = distroCheck.stdout.trim().toLowerCase();

      let installCommand = null;

      if (distro === "debian" || distro === "ubuntu") {
        installCommand =
          "apt-get update -y >/dev/null 2>&1 && apt-get install -y cron >/dev/null 2>&1";
      } else if (distro === "centos" || distro === "rhel" || distro === "fedora") {
        // Essayer dnf d'abord, puis yum
        const dnfCheck = await executeHostCommand("which dnf 2>/dev/null", {
          timeout: 5000,
        });
        if (!dnfCheck.error && dnfCheck.stdout.trim()) {
          installCommand = "dnf install -y cronie >/dev/null 2>&1";
        } else {
          installCommand = "yum install -y cronie >/dev/null 2>&1";
        }
      } else if (distro === "arch" || distro === "manjaro") {
        installCommand = "pacman -Sy --noconfirm cronie >/dev/null 2>&1";
      } else if (distro === "alpine") {
        installCommand = "apk add --no-cache dcron >/dev/null 2>&1";
      } else {
        // Distribution inconnue, essayer apt-get par défaut
        logger.warn(
          `Distribution inconnue (${distro}), tentative d'installation avec apt-get`
        );
        installCommand =
          "apt-get update -y >/dev/null 2>&1 && apt-get install -y cron >/dev/null 2>&1";
      }

      if (installCommand) {
        logger.info(`Installation de cron avec: ${installCommand.split(" >")[0]}`);
        const installResult = await executeHostCommand(installCommand, {
          timeout: 120000, // 2 minutes
        });

        if (installResult.error) {
          logger.warn("Erreur lors de l'installation de cron", {
            stderr: installResult.stderr,
            stdout: installResult.stdout,
          });
          throw new Error(
            `Échec de l'installation de cron: ${installResult.stderr || installResult.stdout || "Erreur inconnue"}`
          );
        } else {
          logger.info("Cron installé avec succès");
        }
      } else {
        throw new Error(
          `Impossible de déterminer la commande d'installation pour la distribution: ${distro}`
        );
      }
    }

    // 4. Démarrer le service cron s'il n'est pas en cours d'exécution
    if (!cronRunning) {
      logger.info("Démarrage du service cron...");

      // Essayer systemctl d'abord
      const systemctlStart = await executeHostCommand(
        "systemctl start cron 2>/dev/null || systemctl start crond 2>/dev/null || echo 'systemctl_failed'",
        { timeout: 30000 }
      );

      if (systemctlStart.stdout.trim() === "systemctl_failed") {
        // Essayer service (init.d)
        await executeHostCommand(
          "service cron start 2>/dev/null || service crond start 2>/dev/null || true",
          { timeout: 30000 }
        );
      }

      // Vérifier à nouveau si cron est maintenant en cours d'exécution
      const verifyCheck = await executeHostCommand(
        "systemctl is-active cron 2>/dev/null || systemctl is-active crond 2>/dev/null || pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1 || echo 'inactive'",
        { timeout: 5000 }
      );

      if (verifyCheck.stdout.trim() === "inactive") {
        logger.warn(
          "Le service cron n'a pas pu être démarré automatiquement. Veuillez le démarrer manuellement."
        );
      } else {
        logger.info("Service cron démarré avec succès");
      }

      // Activer cron au démarrage
      await executeHostCommand(
        "systemctl enable cron 2>/dev/null || systemctl enable crond 2>/dev/null || true",
        { timeout: 10000 }
      );
    } else {
      logger.debug("Cron est déjà installé et en cours d'exécution");
    }
  } catch (error) {
    logger.error("Erreur lors de la vérification/installation de cron", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

