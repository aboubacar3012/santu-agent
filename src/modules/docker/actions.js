/**
 * Actions Docker pour l'agent.
 *
 * Cette couche encapsule toutes les opérations autorisées sur Docker afin de :
 * - centraliser la validation/sanitization des paramètres,
 * - unifier la journalisation,
 * - fournir des réponses formatées prêtes à être envoyées via WebSocket.
 *
 * Chaque fonction suit la même structure :
 * 1. Récupérer l'instance Docker partagée (via `getDocker`).
 * 2. Valider les paramètres grâce au validator.
 * 3. Appeler l'API Dockerode correspondante.
 * 4. Logger les erreurs/succès pour faciliter le troubleshooting.
 *
 * @module modules/docker/actions
 */

import { getDocker } from "./manager.js";
import { logger } from "../../utils/logger.js";
import { validateDockerParams } from "../../utils/validator.js";

/**
 * Liste les conteneurs Docker
 * @param {Object} params - Paramètres
 * @param {boolean} [params.all=false] - Inclure les conteneurs arrêtés
 * @returns {Promise<Array>} Liste des conteneurs
 */
export async function listContainers(params = {}) {
  try {
    const docker = getDocker();
    const { all = false } = validateDockerParams("list", params);
    const containers = await docker.listContainers({ all });
    const enrichedContainers = await Promise.all(
      containers.map(async (container) => {
        let resourceUsage = null;

        try {
          const stats = await fetchContainerStatsSnapshot(docker, container.Id);
          if (stats) {
            resourceUsage = formatResourceUsage(stats);
          }
        } catch (statsError) {
          logger.warn("Impossible de récupérer les stats du conteneur", {
            containerId: container.Id,
            error: statsError.message,
          });
        }

        return {
          id: container.Id,
          names: container.Names,
          image: container.Image,
          status: container.Status,
          state: container.State,
          created: container.Created,
          ports: container.Ports,
          resourceUsage,
        };
      })
    );

    return enrichedContainers;
  } catch (error) {
    logger.error("Erreur lors de la liste des conteneurs", {
      error: error.message,
    });
    throw error;
  }
}

/**
 * Inspecte un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @returns {Promise<Object>} Informations du conteneur
 */
export async function inspectContainer(params) {
  try {
    const docker = getDocker();
    const { container } = validateDockerParams("inspect", params);
    const containerObj = docker.getContainer(container);
    const info = await containerObj.inspect();
    return {
      id: info.Id,
      name: info.Name,
      state: info.State,
      config: {
        image: info.Config.Image,
        env: info.Config.Env,
        cmd: info.Config.Cmd,
      },
      networkSettings: {
        ipAddress: info.NetworkSettings.IPAddress,
        ports: info.NetworkSettings.Ports,
      },
    };
  } catch (error) {
    logger.error("Erreur lors de l'inspection du conteneur", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Démarre un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @returns {Promise<Object>} Résultat
 */
export async function startContainer(params) {
  try {
    const docker = getDocker();
    const { container } = validateDockerParams("start", params);
    const containerObj = docker.getContainer(container);
    await containerObj.start();
    logger.info("Conteneur démarré", { container });
    return { success: true, message: `Conteneur ${container} démarré` };
  } catch (error) {
    logger.error("Erreur lors du démarrage du conteneur", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Arrête un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @returns {Promise<Object>} Résultat
 */
export async function stopContainer(params) {
  try {
    const docker = getDocker();
    const { container } = validateDockerParams("stop", params);
    const containerObj = docker.getContainer(container);
    await containerObj.stop();
    logger.info("Conteneur arrêté", { container });
    return { success: true, message: `Conteneur ${container} arrêté` };
  } catch (error) {
    logger.error("Erreur lors de l'arrêt du conteneur", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Redémarre un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @returns {Promise<Object>} Résultat
 */
export async function restartContainer(params) {
  try {
    const docker = getDocker();
    const { container } = validateDockerParams("restart", params);
    const containerObj = docker.getContainer(container);
    await containerObj.restart();
    logger.info("Conteneur redémarré", { container });
    return { success: true, message: `Conteneur ${container} redémarré` };
  } catch (error) {
    logger.error("Erreur lors du redémarrage du conteneur", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Récupère les logs d'un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @param {number} [params.tail=100] - Nombre de lignes à récupérer
 * @param {boolean} [params.follow=false] - Suivre les logs en temps réel
 * @param {Function} [onData] - Callback pour les données de stream
 * @returns {Promise<Object|Stream>} Logs ou stream
 */
export async function getContainerLogs(params, onData = null) {
  try {
    const docker = getDocker();
    const { container, tail, follow } = validateDockerParams("logs", params);
    const containerObj = docker.getContainer(container);

    if (follow && onData) {
      // Mode streaming
      const stream = await containerObj.logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: tail || 100,
        timestamps: true,
      });

      stream.on("data", (chunk) => {
        onData(chunk.toString());
      });

      stream.on("error", (error) => {
        logger.error("Erreur lors de la lecture des logs", {
          container,
          error: error.message,
        });
      });

      return { stream, type: "stream" };
    } else {
      // Mode one-shot
      const logs = await containerObj.logs({
        stdout: true,
        stderr: true,
        tail: tail || 100,
        timestamps: true,
      });
      return { logs: logs.toString(), type: "one-shot" };
    }
  } catch (error) {
    logger.error("Erreur lors de la récupération des logs", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Récupère les statistiques d'un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @param {Function} [onStats] - Callback pour les statistiques en temps réel
 * @returns {Promise<Object|Stats>} Statistiques ou stream
 */
export async function getContainerStats(params, onStats = null) {
  try {
    const docker = getDocker();
    const { container } = validateDockerParams("stats", params);
    const containerObj = docker.getContainer(container);

    if (onStats) {
      // Mode streaming
      const stats = containerObj.stats({ stream: true });
      stats.on("data", (chunk) => {
        try {
          const data = JSON.parse(chunk.toString());
          onStats({
            cpu: calculateCpuPercent(data),
            memory: {
              usage: data.memory_stats.usage || 0,
              limit: data.memory_stats.limit || 0,
              percent:
                data.memory_stats.limit > 0
                  ? (
                      (data.memory_stats.usage / data.memory_stats.limit) *
                      100
                    ).toFixed(2)
                  : 0,
            },
            network: data.networks || {},
            blockIO: data.blkio_stats || {},
          });
        } catch (error) {
          logger.error("Erreur lors du parsing des stats", {
            error: error.message,
          });
        }
      });

      stats.on("error", (error) => {
        logger.error("Erreur lors de la récupération des stats", {
          container,
          error: error.message,
        });
      });

      return { stats, type: "stream" };
    } else {
      // Mode one-shot - récupérer la première donnée du stream
      return new Promise((resolve, reject) => {
        const stats = containerObj.stats({ stream: false });
        stats.on("data", (chunk) => {
          try {
            const data = JSON.parse(chunk.toString());
            resolve({
              cpu: calculateCpuPercent(data),
              memory: {
                usage: data.memory_stats.usage || 0,
                limit: data.memory_stats.limit || 0,
                percent:
                  data.memory_stats.limit > 0
                    ? (
                        (data.memory_stats.usage / data.memory_stats.limit) *
                        100
                      ).toFixed(2)
                    : 0,
              },
              network: data.networks || {},
              blockIO: data.blkio_stats || {},
              type: "one-shot",
            });
            stats.destroy();
          } catch (error) {
            stats.destroy();
            reject(error);
          }
        });

        stats.on("error", (error) => {
          reject(error);
        });
      });
    }
  } catch (error) {
    logger.error("Erreur lors de la récupération des statistiques", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Calcule le pourcentage CPU utilisé
 * @param {Object} stats - Statistiques Docker
 * @returns {number} Pourcentage CPU
 */
function calculateCpuPercent(stats) {
  const cpuDelta =
    stats.cpu_stats.cpu_usage.total_usage -
    (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta =
    stats.cpu_stats.system_cpu_usage -
    (stats.precpu_stats?.system_cpu_usage || 0);
  const numCpus = stats.cpu_stats.online_cpus || 1;

  if (systemDelta > 0 && cpuDelta > 0) {
    return ((cpuDelta / systemDelta) * numCpus * 100).toFixed(2);
  }
  return "0.00";
}

async function fetchContainerStatsSnapshot(docker, containerId) {
  const container = docker.getContainer(containerId);
  const stream = await container.stats({ stream: false });

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (stream?.destroy) {
        try {
          stream.destroy();
        } catch {
          // ignore cleanup errors
        }
      }
    };

    stream.on("data", (chunk) => {
      try {
        const parsed = JSON.parse(chunk.toString());
        cleanup();
        resolve(parsed);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });

    stream.on("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

function formatResourceUsage(stats) {
  if (!stats) {
    return null;
  }

  const memoryUsage = stats.memory_stats?.usage || 0;
  const memoryLimit = stats.memory_stats?.limit || 0;
  const cpuPercent = calculateCpuPercent(stats);
  const { rxBytes, txBytes } = aggregateNetworkBytes(stats.networks);
  const { readBytes, writeBytes } = aggregateBlockIO(stats.blkio_stats);

  return {
    memory: formatBytes(memoryUsage),
    memoryLimit: memoryLimit ? formatBytes(memoryLimit) : undefined,
    cpu: `${cpuPercent}%`,
    networkIO:
      rxBytes || txBytes
        ? `${formatBytes(rxBytes)} / ${formatBytes(txBytes)}`
        : undefined,
    blockIO:
      readBytes || writeBytes
        ? `${formatBytes(readBytes)} / ${formatBytes(writeBytes)}`
        : undefined,
  };
}

function aggregateNetworkBytes(networks = {}) {
  return Object.values(networks).reduce(
    (acc, iface) => {
      const rx = iface?.rx_bytes || 0;
      const tx = iface?.tx_bytes || 0;
      return {
        rxBytes: acc.rxBytes + rx,
        txBytes: acc.txBytes + tx,
      };
    },
    { rxBytes: 0, txBytes: 0 }
  );
}

function aggregateBlockIO(blkioStats = {}) {
  const recursive = blkioStats.io_service_bytes_recursive || [];

  return recursive.reduce(
    (acc, entry) => {
      const op = entry?.op?.toLowerCase();
      const value = entry?.value || 0;

      if (op === "read") {
        acc.readBytes += value;
      } else if (op === "write") {
        acc.writeBytes += value;
      }

      return acc;
    },
    { readBytes: 0, writeBytes: 0 }
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

/**
 * Exécute une commande dans un conteneur Docker
 * @param {Object} params - Paramètres
 * @param {string} params.container - Nom ou ID du conteneur
 * @param {string|Array} params.command - Commande à exécuter
 * @returns {Promise<Object>} Résultat de l'exécution
 */
export async function execContainer(params) {
  try {
    const docker = getDocker();
    const { container, command } = validateDockerParams("exec", params);
    const containerObj = docker.getContainer(container);

    const exec = await containerObj.exec({
      Cmd: Array.isArray(command) ? command : [command],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    
    let stdout = "";
    let stderr = "";

    return new Promise((resolve, reject) => {
      stream.on("data", (chunk) => {
        const output = chunk.toString();
        // Docker envoie les données avec un préfixe de 8 bytes
        if (chunk[0] === 1) {
          stdout += output.slice(8);
        } else if (chunk[0] === 2) {
          stderr += output.slice(8);
        } else {
          stdout += output;
        }
      });

      stream.on("end", () => {
        resolve({ stdout, stderr, exitCode: 0 });
      });

      stream.on("error", (error) => {
        reject(error);
      });
    });
  } catch (error) {
    logger.error("Erreur lors de l'exécution dans le conteneur", {
      container: params.container,
      error: error.message,
    });
    throw error;
  }
}

