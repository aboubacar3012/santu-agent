/**
 * Collecteur d'événements d'activité en arrière-plan
 *
 * Ce module collecte continuellement les événements d'activité (Docker, SSH, système)
 * et les stocke dans Redis, même quand aucun client n'est connecté pour les lire.
 *
 * @module modules/activity/activityCollector
 */

import { logger } from "../../shared/logger.js";
import { storeActivityEvent, generateActivityKey } from "../../shared/redis.js";
import { getDocker } from "../docker/manager.js";
import { executeCommand } from "../../shared/executor.js";
import { spawn } from "child_process";

let dockerEventsCollector = null;
let dockerEventsInterval = null; // Intervalle pour vérifier les événements Docker périodiquement
let sshEventsCollectors = [];
let systemEventsInterval = null;
let isCollecting = false;
let currentActivityKey = null;
let keyUpdateInterval = null;

let lastCPUTotals = null;
let lastSystemEventSent = {};
let lastDockerEventsCheck = Date.now(); // Timestamp du dernier check Docker
const cooldownPeriod = 10 * 60 * 1000; // 10 minutes
const COLLECTION_INTERVAL = 10 * 1000; // 10 secondes (comme dans le Python)

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

    logger.debug("Connexion SSH réussie détectée (collecteur)", {
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

    logger.debug("Échec de connexion SSH détecté (collecteur)", {
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

    logger.debug("Connexion SSH bloquée détectée (collecteur)", {
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
 * Traite un événement Docker et le stocke dans Redis
 */
function processDockerEvent(event) {
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

      logger.debug("Événement Docker détecté (collecteur)", {
        eventType,
        container: containerName,
        action: Action,
      });

      // Mettre à jour la clé si nécessaire (au cas où on change de jour)
      const activityKey =
        currentActivityKey || generateActivityKey("activity:events");
      storeActivityEvent(activityKey, systemEvent).catch((error) => {
        logger.warn("Erreur stockage événement Docker", {
          error: error.message,
        });
      });
    }
  } catch (error) {
    logger.debug("Erreur parsing événement Docker", {
      error: error.message,
    });
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
 * Vérifie les événements Docker récents (approche périodique comme dans le Python)
 */
async function checkDockerEvents() {
  try {
    const sinceTimestamp = Math.floor(lastDockerEventsCheck / 1000);
    const untilTimestamp = Math.floor(Date.now() / 1000);

    // Utiliser la commande docker events directement comme dans le Python
    // Utiliser nsenter pour accéder à Docker depuis le conteneur
    const escapedCommand =
      `docker events --since ${sinceTimestamp} --until ${untilTimestamp} --format '{{json .}}'`.replace(
        /'/g,
        "'\"'\"'"
      );
    const command = `nsenter -t 1 -m -u -i -n -p -- sh -c '${escapedCommand}'`;

    const { stdout, stderr, error } = await executeCommand(command, {
      timeout: 10000,
    });

    if (error) {
      logger.debug("Erreur lors de la vérification des événements Docker", {
        error: error.message,
        stderr,
      });
      return;
    }

    if (!stdout || !stdout.trim()) {
      // Pas d'événements, c'est normal
      return;
    }

    // Parser chaque ligne (chaque ligne est un JSON)
    const lines = stdout.trim().split("\n");
    for (const line of lines) {
      if (line.trim()) {
        try {
          const event = JSON.parse(line);
          logger.debug("Événement Docker détecté (check périodique)", {
            type: event.Type,
            action: event.Action,
            container: event.Actor?.Attributes?.name,
          });
          processDockerEvent(event);
        } catch (parseError) {
          logger.debug("Erreur parsing événement Docker", {
            error: parseError.message,
            line: line.substring(0, 100),
          });
        }
      }
    }

    // Mettre à jour le timestamp du dernier check
    lastDockerEventsCheck = Date.now();
  } catch (error) {
    logger.error("Erreur lors de la vérification des événements Docker", {
      error: error.message,
      stack: error.stack,
    });
  }
}

/**
 * Collecte les événements Docker en arrière-plan (approche périodique)
 */
async function startDockerEventsCollector() {
  try {
    logger.debug(
      "Démarrage du collecteur d'événements Docker (mode périodique)"
    );

    // Initialiser le timestamp du dernier check
    lastDockerEventsCheck = Date.now();

    // Faire un premier check immédiatement
    await checkDockerEvents();

    // Ensuite, vérifier périodiquement toutes les 10 secondes (comme dans le Python)
    dockerEventsInterval = setInterval(async () => {
      await checkDockerEvents();
    }, COLLECTION_INTERVAL);

    logger.debug(
      "Collecteur d'événements Docker démarré avec succès (mode périodique)"
    );
  } catch (error) {
    logger.error("Erreur démarrage collecteur Docker", {
      error: error.message,
      stack: error.stack,
    });
  }
}

/**
 * Collecte les événements SSH en arrière-plan
 */
async function startSSHEventsCollector() {
  try {
    const logFiles = [
      "/var/log/auth.log", // Debian/Ubuntu
      "/var/log/secure", // RHEL/CentOS
      "/var/log/syslog", // Alternative
      "/var/log/messages", // Alternative
    ];

    for (const logFile of logFiles) {
      try {
        // D'abord lire les dernières lignes du fichier pour capturer les événements récents
        // Puis suivre les nouvelles lignes avec tail -f
        const readLastLinesCommand = `nsenter -t 1 -m -u -i -n -p -- sh -c 'tail -n 100 ${logFile} 2>/dev/null || true'`;

        try {
          const { stdout } = await executeCommand(readLastLinesCommand, {
            timeout: 5000,
          });

          if (stdout) {
            const lines = stdout.split("\n");
            for (const line of lines) {
              if (line.trim() && line.toLowerCase().includes("ssh")) {
                const event = parseSSHLogLine(line);
                if (event) {
                  logger.debug(
                    "Événement SSH trouvé dans les dernières lignes",
                    {
                      logFile,
                      eventType: event.eventType,
                    }
                  );
                  // Mettre à jour la clé si nécessaire (au cas où on change de jour)
                  const activityKey =
                    currentActivityKey ||
                    generateActivityKey("activity:events");
                  await storeActivityEvent(activityKey, event).catch(
                    (error) => {
                      logger.warn("Erreur stockage événement SSH initial", {
                        error: error.message,
                      });
                    }
                  );
                }
              }
            }
          }
        } catch (error) {
          logger.debug(
            `Impossible de lire les dernières lignes de ${logFile}`,
            {
              error: error.message,
            }
          );
        }

        // Maintenant suivre les nouvelles lignes avec tail -f
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
                logger.debug("Nouvel événement SSH détecté", {
                  logFile,
                  eventType: event.eventType,
                  metadata: event.metadata,
                });
                // Mettre à jour la clé si nécessaire (au cas où on change de jour)
                const activityKey =
                  currentActivityKey || generateActivityKey("activity:events");
                storeActivityEvent(activityKey, event).catch((error) => {
                  logger.warn("Erreur stockage événement SSH", {
                    error: error.message,
                  });
                });
              }
            }
          }
        });

        tailProcess.stderr.on("data", (chunk) => {
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

        sshEventsCollectors.push(tailProcess);
      } catch (error) {
        logger.debug(`Impossible d'accéder à ${logFile}`, {
          error: error.message,
        });
      }
    }
  } catch (error) {
    logger.error("Erreur démarrage collecteur SSH", { error: error.message });
  }
}

/**
 * Collecte les événements système (CPU, mémoire, disque) en arrière-plan
 */
function startSystemEventsCollector() {
  logger.debug("Démarrage du collecteur d'événements système");

  systemEventsInterval = setInterval(async () => {
    try {
      const now = Date.now();

      // Vérifier CPU
      const cpuResult = await getCPUUsage(lastCPUTotals);
      if (cpuResult) {
        lastCPUTotals = cpuResult.totals;
        logger.debug("Vérification CPU", {
          cpuUsage: cpuResult.cpu,
          threshold: 85,
        });
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
            logger.debug("Événement système CPU détecté (collecteur)", {
              cpuUsage: cpuResult.cpu,
            });
            // Mettre à jour la clé si nécessaire (au cas où on change de jour)
            const activityKey =
              currentActivityKey || generateActivityKey("activity:events");
            storeActivityEvent(activityKey, event).catch((error) => {
              logger.warn("Erreur stockage événement système CPU", {
                error: error.message,
              });
            });
            lastSystemEventSent["HIGH_CPU_USAGE"] = now;
          }
        }
      }

      // Vérifier mémoire
      const memoryUsage = await getMemoryUsage();
      logger.debug("Vérification mémoire", {
        memoryUsage,
        threshold: 85,
      });
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
          logger.debug("Événement système mémoire détecté (collecteur)", {
            memoryUsage,
          });
          // Mettre à jour la clé si nécessaire (au cas où on change de jour)
          const activityKey =
            currentActivityKey || generateActivityKey("activity:events");
          storeActivityEvent(activityKey, event).catch((error) => {
            logger.warn("Erreur stockage événement système mémoire", {
              error: error.message,
            });
          });
          lastSystemEventSent["HIGH_MEMORY_USAGE"] = now;
        }
      }

      // Vérifier disque
      const diskUsage = await getDiskUsage();
      logger.debug("Vérification disque", {
        diskUsage,
        threshold: 85,
      });
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
          logger.debug("Événement système disque détecté (collecteur)", {
            diskUsage,
          });
          // Mettre à jour la clé si nécessaire (au cas où on change de jour)
          const activityKey =
            currentActivityKey || generateActivityKey("activity:events");
          storeActivityEvent(activityKey, event).catch((error) => {
            logger.warn("Erreur stockage événement système disque", {
              error: error.message,
            });
          });
          lastSystemEventSent["HIGH_DISK_USAGE"] = now;
        }
      }
    } catch (error) {
      logger.error("Erreur collecte événements système", {
        error: error.message,
        stack: error.stack,
      });
    }
  }, 10000); // Vérifier toutes les 10 secondes

  logger.debug("Collecteur d'événements système démarré avec succès");
}

/**
 * Démarre la collecte d'événements d'activité en arrière-plan
 * @returns {Promise<void>}
 */
export async function startActivityCollector() {
  if (isCollecting) {
    logger.debug("Le collecteur d'activité est déjà en cours d'exécution");
    return;
  }

  try {
    logger.info(
      "Démarrage du collecteur d'événements d'activité en arrière-plan"
    );

    // Fonction pour mettre à jour la clé Redis (appelée au démarrage et chaque jour)
    const updateActivityKey = () => {
      const newKey = generateActivityKey("activity:events");
      if (currentActivityKey !== newKey) {
        logger.debug(
          "Mise à jour de la clé Redis pour les événements d'activité",
          {
            oldKey: currentActivityKey,
            newKey,
          }
        );
        currentActivityKey = newKey;
      }
      return currentActivityKey;
    };

    // Initialiser la clé
    currentActivityKey = updateActivityKey();

    // Mettre à jour la clé toutes les heures pour s'assurer qu'on utilise la bonne clé du jour
    keyUpdateInterval = setInterval(() => {
      updateActivityKey();
    }, 60 * 60 * 1000); // Toutes les heures

    // Démarrer les collecteurs pour toutes les sources
    logger.debug("Démarrage des collecteurs d'événements...");
    await startDockerEventsCollector();
    logger.debug("Collecteur Docker démarré");
    await startSSHEventsCollector();
    logger.debug("Collecteur SSH démarré");
    startSystemEventsCollector();
    logger.debug("Collecteur système démarré");

    isCollecting = true;

    logger.info("Collecteur d'événements d'activité démarré avec succès", {
      docker: !!dockerEventsInterval,
      ssh: sshEventsCollectors.length > 0,
      system: !!systemEventsInterval,
    });
  } catch (error) {
    logger.error("Erreur lors du démarrage du collecteur d'activité", {
      error: error.message,
    });
    isCollecting = false;
  }
}

/**
 * Arrête la collecte d'événements d'activité
 * @returns {Promise<void>}
 */
export async function stopActivityCollector() {
  if (!isCollecting) {
    return;
  }

  try {
    logger.info("Arrêt du collecteur d'événements d'activité");

    // Nettoyer l'intervalle de mise à jour de la clé
    if (keyUpdateInterval) {
      clearInterval(keyUpdateInterval);
      keyUpdateInterval = null;
    }

    // Arrêter Docker events (intervalle périodique)
    if (dockerEventsInterval) {
      clearInterval(dockerEventsInterval);
      dockerEventsInterval = null;
    }
    dockerEventsCollector = null;

    // Arrêter SSH collectors
    sshEventsCollectors.forEach((process) => {
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
        logger.warn("Erreur lors de l'arrêt du collecteur SSH", {
          error: error.message,
        });
      }
    });
    sshEventsCollectors = [];

    // Arrêter système events
    if (systemEventsInterval) {
      clearInterval(systemEventsInterval);
      systemEventsInterval = null;
    }

    isCollecting = false;
    currentActivityKey = null;

    logger.info("Collecteur d'événements d'activité arrêté");
  } catch (error) {
    logger.error("Erreur lors de l'arrêt du collecteur d'activité", {
      error: error.message,
    });
  }
}

/**
 * Vérifie si le collecteur est actif
 * @returns {boolean} True si le collecteur est actif
 */
export function isCollectorActive() {
  return isCollecting;
}
