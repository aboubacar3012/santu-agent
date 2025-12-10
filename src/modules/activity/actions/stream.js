/**
 * Action stream - Collecte les événements système en temps réel
 *
 * @module modules/activity/actions/stream
 */

import { spawn } from "child_process";
import { logger } from "../../../shared/logger.js";
import { validateActivityParams } from "../validator.js";
import { getDocker } from "../../docker/manager.js";
import { executeCommand } from "../../../shared/executor.js";
import {
  getCachedActivityEventsLast7Days,
  storeActivityEvent,
  generateActivityKey,
} from "../../../shared/redis.js";

/**
 * Crée un événement système formaté
 */
function createSystemEvent(
  eventType,
  severity,
  title,
  description,
  source,
  metadata = {}
) {
  return {
    timestamp: new Date().toISOString(),
    eventType,
    severity,
    title,
    description,
    source,
    metadata,
  };
}

/**
 * Parse une ligne de log SSH pour extraire les événements
 */
function parseSSHLogLine(line) {
  if (!line || !line.trim()) return null;

  const lineLower = line.toLowerCase();

  // Vérifier si c'est une ligne SSH (sshd, ssh, ou contient des patterns SSH)
  const isSSHLine =
    lineLower.includes("sshd") ||
    lineLower.includes("ssh:") ||
    lineLower.includes("accepted") ||
    lineLower.includes("failed password") ||
    lineLower.includes("invalid user") ||
    lineLower.includes("connection closed") ||
    lineLower.includes("preauth");

  if (!isSSHLine) return null;

  // Connexion réussie
  if (
    lineLower.includes("accepted") &&
    (lineLower.includes("publickey") ||
      lineLower.includes("password") ||
      lineLower.includes("keyboard-interactive"))
  ) {
    const ipMatch = line.match(/from\s+([\d.]+)/i);
    const userMatch = line.match(/for\s+(\S+)/i);
    const ip = ipMatch ? ipMatch[1] : "unknown";
    const user = userMatch ? userMatch[1] : "unknown";

    logger.debug("Connexion SSH réussie détectée", {
      user,
      ip,
      line: line.substring(0, 100),
    });

    return createSystemEvent(
      "SSH_CONNECTION_SUCCESS",
      "MEDIUM",
      `SSH connection successful`,
      `User ${user} connected from ${ip}`,
      "ssh",
      {
        username: user,
        ip,
        type: "success",
      }
    );
  }

  // Échec de connexion
  if (
    lineLower.includes("failed password") ||
    lineLower.includes("invalid user") ||
    lineLower.includes("authentication failure")
  ) {
    const ipMatch = line.match(/from\s+([\d.]+)/i);
    const userMatch = line.match(/for\s+(\S+)/i) || line.match(/user\s+(\S+)/i);
    const ip = ipMatch ? ipMatch[1] : "unknown";
    const user = userMatch ? userMatch[1] : "unknown";

    logger.debug("Échec de connexion SSH détecté", {
      user,
      ip,
      line: line.substring(0, 100),
    });

    return createSystemEvent(
      "SSH_CONNECTION_FAILED",
      "HIGH",
      `SSH connection failed`,
      `Failed login attempt for user ${user} from ${ip}`,
      "ssh",
      {
        username: user,
        ip,
        type: "failed",
      }
    );
  }

  // Connexion bloquée
  if (
    lineLower.includes("connection closed") ||
    lineLower.includes("preauth") ||
    lineLower.includes("disconnect")
  ) {
    const ipMatch = line.match(/from\s+([\d.]+)/i);
    const ip = ipMatch ? ipMatch[1] : "unknown";

    logger.debug("Connexion SSH bloquée détectée", {
      ip,
      line: line.substring(0, 100),
    });

    return createSystemEvent(
      "SSH_CONNECTION_BLOCKED",
      "MEDIUM",
      `SSH connection blocked`,
      `Connection blocked from ${ip}`,
      "ssh",
      {
        ip,
        type: "blocked",
      }
    );
  }

  return null;
}

/**
 * Traite un événement Docker et l'envoie via le callback
 */
function processDockerEvent(event, callbacks) {
  try {
    const { Action, Type, Actor } = event;

    if (Type === "container") {
      let eventType, severity, title, description;
      const containerName = Actor?.Attributes?.name || "unknown";
      const image = Actor?.Attributes?.image || "unknown";

      switch (Action) {
        case "start":
          eventType = "DOCKER_CONTAINER_STARTED";
          severity = "MEDIUM";
          title = "Container started";
          description = `Container ${containerName} started`;
          break;
        case "stop":
          eventType = "DOCKER_CONTAINER_STOPPED";
          severity = "MEDIUM";
          title = "Container stopped";
          description = `Container ${containerName} stopped`;
          break;
        case "die":
          eventType = "DOCKER_CONTAINER_ERROR";
          severity = "HIGH";
          title = "Container error";
          description = `Container ${containerName} exited unexpectedly`;
          break;
        case "restart":
          eventType = "DOCKER_CONTAINER_RESTARTED";
          severity = "MEDIUM";
          title = "Container restarted";
          description = `Container ${containerName} restarted`;
          break;
        default:
          return; // Ignorer les autres actions
      }

      const systemEvent = createSystemEvent(
        eventType,
        severity,
        title,
        description,
        "docker",
        {
          container: containerName,
          image,
          action: Action,
        }
      );

      callbacks.onStream("activity", JSON.stringify(systemEvent));

      // Ne PAS stocker l'événement dans Redis ici car le collecteur en arrière-plan le fait déjà
      // Cela évite les doublons et améliore les performances
      // Le collecteur stocke tous les événements de manière continue, même sans client connecté
    }
  } catch (error) {
    logger.debug("Erreur parsing événement Docker", {
      error: error.message,
    });
  }
}

/**
 * Collecte les événements Docker en temps réel
 */
async function startDockerEventsCollector(callbacks, cleanupFunctions) {
  try {
    const docker = getDocker();

    // Démarrer le stream en temps réel depuis maintenant
    // Note: L'historique est récupéré depuis la base de données côté frontend
    const dockerEvents = docker.getEvents({
      since: Math.floor(Date.now() / 1000), // Timestamp Unix en secondes
    });

    dockerEvents.on("data", (chunk) => {
      try {
        const event = JSON.parse(chunk.toString());
        processDockerEvent(event, callbacks);
      } catch (error) {
        logger.debug("Erreur parsing événement Docker", {
          error: error.message,
        });
      }
    });

    dockerEvents.on("error", (error) => {
      logger.error("Erreur Docker events stream", { error: error.message });
    });

    cleanupFunctions.push(() => {
      try {
        dockerEvents.removeAllListeners();
        dockerEvents.destroy?.();
      } catch (error) {
        logger.warn("Erreur lors du nettoyage Docker events", {
          error: error.message,
        });
      }
    });
  } catch (error) {
    logger.error("Erreur démarrage collecteur Docker", {
      error: error.message,
    });
  }
}

/**
 * Collecte les événements SSH en temps réel
 */
async function startSSHEventsCollector(callbacks, cleanupFunctions) {
  try {
    // Démarrer le streaming en temps réel
    // Note: L'historique est récupéré depuis la base de données côté frontend
    // Déterminer le fichier de log SSH selon l'OS
    const logFiles = [
      "/var/log/auth.log", // Debian/Ubuntu
      "/var/log/secure", // RHEL/CentOS
      "/var/log/syslog", // Alternative
      "/var/log/messages", // Alternative
    ];

    const logProcesses = [];

    for (const logFile of logFiles) {
      try {
        // Utiliser nsenter pour accéder aux logs de l'hôte depuis le conteneur
        const command = `nsenter -t 1 -m -u -i -n -p -- sh -c 'tail -f ${logFile} 2>/dev/null || true'`;
        const tailProcess = spawn("sh", ["-c", command], {
          stdio: ["ignore", "pipe", "pipe"],
        });

        let buffer = "";

        tailProcess.stdout.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.trim()) {
              const event = parseSSHLogLine(line);
              if (event) {
                logger.debug("Événement SSH détecté dans le stream", {
                  eventType: event.eventType,
                  source: event.source,
                  metadata: event.metadata,
                });
                callbacks.onStream("activity", JSON.stringify(event));

                // Ne PAS stocker l'événement dans Redis ici car le collecteur en arrière-plan le fait déjà
                // Cela évite les doublons et améliore les performances
                // Le collecteur stocke tous les événements de manière continue, même sans client connecté
              }
            }
          }
        });

        tailProcess.stderr.on("data", (chunk) => {
          // Ignorer les erreurs de fichiers inexistants
          const error = chunk.toString();
          if (
            !error.includes("No such file") &&
            !error.includes("cannot open")
          ) {
            logger.debug("Erreur tail SSH logs", { error });
          }
        });

        tailProcess.on("error", (error) => {
          logger.debug("Erreur processus tail SSH", { error: error.message });
        });

        logProcesses.push(tailProcess);
      } catch (error) {
        logger.debug(`Impossible d'accéder à ${logFile}`, {
          error: error.message,
        });
      }
    }

    cleanupFunctions.push(() => {
      logProcesses.forEach((process) => {
        try {
          if (!process.killed) {
            process.kill("SIGTERM");
            setTimeout(() => {
              if (!process.killed) {
                process.kill("SIGKILL");
              }
            }, 1000);
          }
        } catch (error) {
          logger.warn("Erreur nettoyage processus SSH", {
            error: error.message,
          });
        }
      });
    });
  } catch (error) {
    logger.error("Erreur démarrage collecteur SSH", { error: error.message });
  }
}

/**
 * Obtient l'utilisation CPU depuis /proc/stat
 */
async function getCPUUsage(lastTotals) {
  try {
    const { stdout } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- cat /proc/stat | head -1",
      { timeout: 5000 }
    );

    if (!stdout) return null;

    const parts = stdout.trim().split(/\s+/);
    const user = parseInt(parts[1], 10);
    const nice = parseInt(parts[2], 10);
    const system = parseInt(parts[3], 10);
    const idle = parseInt(parts[4], 10);
    const iowait = parseInt(parts[5], 10) || 0;

    const total = user + nice + system + idle + iowait;
    const nonIdle = user + nice + system + iowait;

    if (!lastTotals) {
      return { cpu: null, totals: { total, idle } };
    }

    const totalDiff = total - lastTotals.total;
    const idleDiff = idle - lastTotals.idle;

    if (totalDiff === 0) return { cpu: null, totals: { total, idle } };

    const cpuUsage = ((totalDiff - idleDiff) / totalDiff) * 100;
    return {
      cpu: Math.round(cpuUsage * 100) / 100,
      totals: { total, idle },
    };
  } catch (error) {
    logger.debug("Erreur calcul CPU", { error: error.message });
    return null;
  }
}

/**
 * Obtient l'utilisation mémoire
 */
async function getMemoryUsage() {
  try {
    const { stdout } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- free -m",
      { timeout: 5000 }
    );

    if (!stdout) return null;

    const lines = stdout.split("\n");
    const memLine = lines[1];
    if (!memLine) return null;

    const parts = memLine.trim().split(/\s+/);
    const total = parseInt(parts[1], 10);
    const used = parseInt(parts[2], 10);

    if (total === 0) return null;

    return (used / total) * 100;
  } catch (error) {
    logger.debug("Erreur calcul mémoire", { error: error.message });
    return null;
  }
}

/**
 * Obtient l'utilisation disque
 */
async function getDiskUsage() {
  try {
    const { stdout } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- df -h / | tail -1",
      { timeout: 5000 }
    );

    if (!stdout) return null;

    const parts = stdout.trim().split(/\s+/);
    const usageStr = parts[4];
    if (!usageStr) return null;

    const usage = parseInt(usageStr.replace("%", ""), 10);
    return isNaN(usage) ? null : usage;
  } catch (error) {
    logger.debug("Erreur calcul disque", { error: error.message });
    return null;
  }
}

/**
 * Obtient les processus les plus gourmands en CPU
 */
async function getTopCPUProcesses(limit = 3) {
  try {
    const { stdout } = await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- ps aux --sort=-%cpu | head -${
        limit + 1
      } | tail -${limit}`,
      { timeout: 5000 }
    );

    if (!stdout) return [];

    const processes = [];
    const lines = stdout.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 11) {
        processes.push({
          user: parts[0],
          pid: parts[1],
          cpu: parseFloat(parts[2]) || 0,
          mem: parseFloat(parts[3]) || 0,
          command: parts.slice(10).join(" ").substring(0, 50),
        });
      }
    }

    return processes;
  } catch (error) {
    logger.debug("Erreur récupération top processus", { error: error.message });
    return [];
  }
}

/**
 * Collecte les événements système (CPU, mémoire, disque)
 */
function startSystemEventsCollector(callbacks, cleanupFunctions) {
  let lastCPUTotals = null;
  let lastSystemEventSent = {};
  const cooldownPeriod = 10 * 60 * 1000; // 10 minutes

  const checkInterval = setInterval(async () => {
    try {
      const now = Date.now();

      // Vérifier CPU
      const cpuResult = await getCPUUsage(lastCPUTotals);
      if (cpuResult) {
        lastCPUTotals = cpuResult.totals;
        if (cpuResult.cpu !== null && cpuResult.cpu > 85) {
          const lastSent = lastSystemEventSent["HIGH_CPU_USAGE"] || 0;
          if (now - lastSent >= cooldownPeriod) {
            const topProcesses = await getTopCPUProcesses(3);
            const event = createSystemEvent(
              "HIGH_CPU_USAGE",
              "HIGH",
              `High CPU usage detected`,
              `CPU usage is ${cpuResult.cpu.toFixed(1)}%`,
              "system",
              {
                cpuUsage: cpuResult.cpu,
                topProcesses,
              }
            );
            callbacks.onStream("activity", JSON.stringify(event));

            // Ne PAS stocker l'événement dans Redis ici car le collecteur en arrière-plan le fait déjà
            // Cela évite les doublons et améliore les performances
            // Le collecteur stocke tous les événements de manière continue, même sans client connecté

            lastSystemEventSent["HIGH_CPU_USAGE"] = now;
          }
        }
      }

      // Vérifier mémoire
      const memoryUsage = await getMemoryUsage();
      if (memoryUsage !== null && memoryUsage > 85) {
        const lastSent = lastSystemEventSent["HIGH_MEMORY_USAGE"] || 0;
        if (now - lastSent >= cooldownPeriod) {
          const event = createSystemEvent(
            "HIGH_MEMORY_USAGE",
            "HIGH",
            `High memory usage detected`,
            `Memory usage is ${memoryUsage.toFixed(1)}%`,
            "system",
            {
              memoryUsage,
            }
          );
          callbacks.onStream("activity", JSON.stringify(event));

          // Stocker l'événement dans Redis (en arrière-plan, ne pas bloquer)
          const activityKey = generateActivityKey("activity:events");
          storeActivityEvent(activityKey, event).catch((error) => {
            // Erreurs de stockage Redis sont déjà loggées dans storeActivityEvent
            // On ne bloque pas le streaming en cas d'erreur Redis
          });

          lastSystemEventSent["HIGH_MEMORY_USAGE"] = now;
        }
      }

      // Vérifier disque
      const diskUsage = await getDiskUsage();
      if (diskUsage !== null && diskUsage > 85) {
        const lastSent = lastSystemEventSent["HIGH_DISK_USAGE"] || 0;
        if (now - lastSent >= cooldownPeriod) {
          const event = createSystemEvent(
            "HIGH_DISK_USAGE",
            "HIGH",
            `High disk usage detected`,
            `Disk usage is ${diskUsage}%`,
            "system",
            {
              diskUsage,
            }
          );
          callbacks.onStream("activity", JSON.stringify(event));

          // Stocker l'événement dans Redis (en arrière-plan, ne pas bloquer)
          const activityKey = generateActivityKey("activity:events");
          storeActivityEvent(activityKey, event).catch((error) => {
            // Erreurs de stockage Redis sont déjà loggées dans storeActivityEvent
            // On ne bloque pas le streaming en cas d'erreur Redis
          });

          lastSystemEventSent["HIGH_DISK_USAGE"] = now;
        }
      }
    } catch (error) {
      logger.error("Erreur collecte événements système", {
        error: error.message,
      });
    }
  }, 30000); // Vérifier toutes les 30 secondes

  cleanupFunctions.push(() => {
    clearInterval(checkInterval);
  });
}

/**
 * Collecte les événements système en temps réel
 * @param {Object} params - Paramètres
 * @param {string[]} [params.sources=["docker", "ssh", "system"]] - Sources à collecter
 * @param {Object} [params.filters={}] - Filtres optionnels
 * @param {Object} callbacks - Callbacks pour le streaming
 * @param {Function} callbacks.onStream - Callback pour les données de stream
 * @returns {Promise<Object>} Informations de stream
 */
export async function streamActivity(params = {}, callbacks = {}) {
  try {
    const validatedParams = validateActivityParams("stream", params);
    const { sources } = validatedParams;

    if (!callbacks.onStream) {
      throw new Error(
        "onStream callback est requis pour le streaming des événements"
      );
    }

    logger.debug("Début du streaming des événements système", { sources });

    // ÉTAPE 1 : Récupérer et envoyer les événements en cache des 7 derniers jours avant de commencer le streaming
    try {
      const cachedEvents = await getCachedActivityEventsLast7Days(
        "activity:events",
        1000
      );
      if (cachedEvents.length > 0) {
        logger.debug(
          `Envoi de ${cachedEvents.length} événements en cache (7 jours)`,
          {
            prefix: "activity:events",
            eventTypes: cachedEvents
              .map((e) => e.event?.eventType)
              .filter(Boolean)
              .slice(0, 5),
          }
        );

        // Envoyer les événements en cache (du plus ancien au plus récent)
        // Les événements sont déjà triés par timestamp dans getCachedActivityEventsLast7Days
        let sentCount = 0;
        for (const cachedEvent of cachedEvents) {
          if (cachedEvent.event) {
            try {
              callbacks.onStream("activity", JSON.stringify(cachedEvent.event));
              sentCount++;
            } catch (error) {
              logger.warn("Erreur lors de l'envoi d'un événement en cache", {
                error: error.message,
                eventType: cachedEvent.event.eventType,
              });
            }
          }
        }

        logger.debug(
          `Événements en cache envoyés (${sentCount}/${cachedEvents.length}), démarrage du streaming en temps réel`
        );
      } else {
        logger.debug(
          "Aucun événement en cache trouvé, démarrage direct du streaming"
        );
      }
    } catch (error) {
      logger.warn("Erreur lors de la récupération des événements en cache", {
        error: error.message,
        stack: error.stack,
      });
      // Continuer même si le cache échoue
    }

    const cleanupFunctions = [];

    // Démarrer les collecteurs selon les sources demandées
    if (sources.includes("docker")) {
      startDockerEventsCollector(callbacks, cleanupFunctions);
    }

    if (sources.includes("ssh")) {
      startSSHEventsCollector(callbacks, cleanupFunctions);
    }

    if (sources.includes("system")) {
      startSystemEventsCollector(callbacks, cleanupFunctions);
    }

    return {
      isStreaming: true,
      initialResponse: {
        stream: "activity",
        mode: "activity.stream",
        sources,
      },
      resource: {
        type: "activity-stream",
        cleanup: () => {
          logger.debug("Nettoyage des collecteurs d'événements");
          cleanupFunctions.forEach((cleanup) => {
            try {
              cleanup();
            } catch (error) {
              logger.warn("Erreur lors du nettoyage", { error: error.message });
            }
          });
        },
      },
    };
  } catch (error) {
    logger.error("Erreur lors du streaming des événements", {
      error: error.message,
    });
    throw error;
  }
}
