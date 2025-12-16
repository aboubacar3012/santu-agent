/**
 * Action stream - Collecte les métriques système en temps réel
 *
 * @module modules/metrics/actions/stream
 */

import { logger } from "../../../shared/logger.js";
import { validateMetricsParams } from "../validator.js";
import { executeCommand } from "../../../shared/executor.js";
import { requireRole } from "../../../websocket/auth.js";

/**
 * Convertit une valeur en float de manière sûre
 * @param {any} value - Valeur à convertir
 * @returns {number|null} Float ou null
 */
function safeFloat(value) {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    const intVal = parseInt(value, 10);
    if (isNaN(intVal)) {
      return null;
    }
    return parseFloat(intVal);
  } catch (error) {
    logger.debug("Erreur lors de la conversion en float", {
      value,
      error: error.message,
    });
    return null;
  }
}

/**
 * Obtient les métriques CPU
 * Calcule le pourcentage d'utilisation sur tous les CPUs (peut dépasser 100% si plusieurs cores)
 */
async function getCPUMetrics() {
  try {
    // Obtenir le nombre de cores d'abord
    const { stdout: cpuCountOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- nproc",
      { timeout: 5000 }
    );
    const cpuCores = cpuCountOutput
      ? parseInt(cpuCountOutput.trim(), 10)
      : null;

    // Lire la ligne "cpu" qui représente la somme de tous les CPUs
    const { stdout: statOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- cat /proc/stat | head -1",
      { timeout: 5000 }
    );

    if (!statOutput) {
      return { usage: 0, cores: cpuCores };
    }

    const parts = statOutput.trim().split(/\s+/);
    const user = parseInt(parts[1], 10) || 0;
    const nice = parseInt(parts[2], 10) || 0;
    const system = parseInt(parts[3], 10) || 0;
    const idle = parseInt(parts[4], 10) || 0;
    const iowait = parseInt(parts[5], 10) || 0;
    const irq = parseInt(parts[6], 10) || 0;
    const softirq = parseInt(parts[7], 10) || 0;

    const total = user + nice + system + idle + iowait + irq + softirq;
    const nonIdle = user + nice + system + iowait + irq + softirq;

    if (!getCPUMetrics.lastTotals) {
      getCPUMetrics.lastTotals = { total, idle };
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return { usage: 0, cores: cpuCores };
    }

    const totalDiff = total - getCPUMetrics.lastTotals.total;
    const idleDiff = idle - getCPUMetrics.lastTotals.idle;

    getCPUMetrics.lastTotals = { total, idle };

    let cpuUsage = 0;
    if (totalDiff > 0) {
      // Calculer le pourcentage moyen par CPU (0-100%)
      const avgUsage = ((totalDiff - idleDiff) / totalDiff) * 100;
      // Multiplier par le nombre de cores pour obtenir le pourcentage total sur tous les CPUs
      // Exemple: 4 CPUs à 50% chacun = 200% total
      cpuUsage = cpuCores ? avgUsage * cpuCores : avgUsage;
      cpuUsage = Math.round(cpuUsage * 100) / 100;
    }

    return {
      usage: cpuUsage,
      cores: cpuCores,
    };
  } catch (error) {
    logger.debug("Erreur collecte métriques CPU", { error: error.message });
    return { usage: 0, cores: null };
  }
}

/**
 * Obtient les métriques mémoire
 */
async function getMemoryMetrics() {
  try {
    const { stdout } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- free -b",
      { timeout: 5000 }
    );

    if (!stdout) {
      return {
        total: safeFloat(0),
        used: safeFloat(0),
        percent: 0,
      };
    }

    const lines = stdout.split("\n");
    const memLine = lines[1];

    if (!memLine) {
      return {
        total: safeFloat(0),
        used: safeFloat(0),
        percent: 0,
      };
    }

    const memParts = memLine.trim().split(/\s+/);
    const total = parseInt(memParts[1], 10) || 0;
    const used = parseInt(memParts[2], 10) || 0;
    const percent =
      total > 0 ? Math.round((used / total) * 100 * 100) / 100 : 0;

    return {
      total: safeFloat(total),
      used: safeFloat(used),
      percent,
    };
  } catch (error) {
    logger.debug("Erreur collecte métriques mémoire", { error: error.message });
    return {
      total: safeFloat(0),
      used: safeFloat(0),
      percent: 0,
    };
  }
}

/**
 * Obtient les métriques disque
 */
async function getDiskMetrics() {
  try {
    const { stdout: dfOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- df -B1 / | tail -1",
      { timeout: 5000 }
    );

    let total = null;
    let used = null;
    let percent = 0;

    if (dfOutput) {
      const parts = dfOutput.trim().split(/\s+/);
      total = parseInt(parts[1], 10) || null;
      used = parseInt(parts[2], 10) || null;

      if (total && total > 0 && used !== null) {
        percent = Math.round((used / total) * 100 * 100) / 100;
      }
    }

    return {
      total: safeFloat(total),
      used: safeFloat(used),
      percent,
    };
  } catch (error) {
    logger.debug("Erreur collecte métriques disque", { error: error.message });
    return {
      total: safeFloat(0),
      used: safeFloat(0),
      percent: 0,
    };
  }
}

/**
 * Obtient les métriques réseau
 */
async function getNetworkMetrics() {
  try {
    const { stdout } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- cat /proc/net/dev",
      { timeout: 5000 }
    );

    if (!stdout) {
      return {
        rxRate: null,
        txRate: null,
      };
    }

    let rxTotal = 0;
    let txTotal = 0;

    const lines = stdout.split("\n");
    for (const line of lines) {
      if (line.includes(":") && !line.includes("lo:")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 10) {
          rxTotal += parseInt(parts[1], 10) || 0;
          txTotal += parseInt(parts[9], 10) || 0;
        }
      }
    }

    const now = Date.now();
    let rxRate = null;
    let txRate = null;

    if (getNetworkMetrics.lastIO) {
      const timeDelta = (now - getNetworkMetrics.lastIO.time) / 1000;
      if (timeDelta > 0) {
        rxRate = (rxTotal - getNetworkMetrics.lastIO.rxTotal) / timeDelta;
        txRate = (txTotal - getNetworkMetrics.lastIO.txTotal) / timeDelta;
        rxRate = Math.round(rxRate * 100) / 100;
        txRate = Math.round(txRate * 100) / 100;
      }
    }

    getNetworkMetrics.lastIO = {
      time: now,
      rxTotal,
      txTotal,
    };

    return {
      rxRate,
      txRate,
    };
  } catch (error) {
    logger.debug("Erreur collecte métriques réseau", { error: error.message });
    return {
      rxRate: null,
      txRate: null,
    };
  }
}

/**
 * Obtient les informations système
 */
async function getSystemInfo() {
  try {
    const { stdout: hostnameOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- hostname",
      { timeout: 5000 }
    );
    const hostname = hostnameOutput ? hostnameOutput.trim() : "unknown";

    const { stdout: uptimeOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- cat /proc/uptime | awk '{print $1}'",
      { timeout: 5000 }
    );
    const uptime = uptimeOutput ? parseFloat(uptimeOutput.trim()) : null;

    const { stdout: procCountOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- ps -e | wc -l",
      { timeout: 5000 }
    );
    const processes = procCountOutput
      ? parseInt(procCountOutput.trim(), 10)
      : null;

    let osName = null;
    try {
      const { stdout: osReleaseOutput } = await executeCommand(
        "nsenter -t 1 -m -u -i -n -p -- cat /etc/os-release | grep PRETTY_NAME | cut -d '=' -f2 | tr -d '\"'",
        { timeout: 5000 }
      );
      if (osReleaseOutput) {
        osName = osReleaseOutput.trim();
      }
    } catch (error) {
      const { stdout: unameOutput } = await executeCommand(
        "nsenter -t 1 -m -u -i -n -p -- uname -a",
        { timeout: 5000 }
      );
      if (unameOutput) {
        osName = unameOutput.trim();
      }
    }

    const { stdout: osVersionOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- uname -r",
      { timeout: 5000 }
    );
    const osVersion = osVersionOutput ? osVersionOutput.trim() : null;

    return {
      hostname,
      uptime: safeFloat(uptime),
      processes,
      osName,
      osVersion: osVersion ? `${osName || "Linux"} ${osVersion}` : null,
    };
  } catch (error) {
    logger.debug("Erreur collecte infos système", { error: error.message });
    return {
      hostname: "unknown",
      uptime: null,
      processes: null,
      osName: null,
      osVersion: null,
    };
  }
}

/**
 * Collecte toutes les métriques système
 */
async function collectAllMetrics() {
  try {
    const timestamp = new Date().toISOString();

    const [cpuMetrics, memoryMetrics, diskMetrics, networkMetrics, systemInfo] =
      await Promise.all([
        getCPUMetrics(),
        getMemoryMetrics(),
        getDiskMetrics(),
        getNetworkMetrics(),
        getSystemInfo(),
      ]);

    const payload = {
      hostname: systemInfo.hostname,
      timestamp,
      metrics: {
        cpuUsage: cpuMetrics.usage,
        cpuCores: cpuMetrics.cores,
        memoryTotal: memoryMetrics.total,
        memoryUsed: memoryMetrics.used,
        memoryPercent: memoryMetrics.percent,
        diskTotal: diskMetrics.total,
        diskUsed: diskMetrics.used,
        diskPercent: diskMetrics.percent,
        networkRxRate: networkMetrics.rxRate,
        networkTxRate: networkMetrics.txRate,
        uptime: systemInfo.uptime,
        processes: systemInfo.processes,
        osName: systemInfo.osName,
        osVersion: systemInfo.osVersion,
      },
    };

    return payload;
  } catch (error) {
    logger.error("Erreur lors de la collecte des métriques", {
      error: error.message,
    });
    throw error;
  }
}

/**
 * Collecte les métriques système en temps réel
 * @param {Object} params - Paramètres
 * @param {number} [params.interval=10] - Intervalle de collecte en secondes
 * @param {Object} callbacks - Callbacks pour le streaming
 * @param {Function} callbacks.onStream - Callback pour les données de stream
 * @returns {Promise<Object>} Informations de stream
 */
export async function streamMetrics(params = {}, callbacks = {}) {
  try {
    // Vérifier les permissions : ADMIN, OWNER, EDITOR et USER peuvent consulter les métriques
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER", "EDITOR", "USER"],
      "consulter les métriques système"
    );

    const validatedParams = validateMetricsParams("stream", params);
    const { interval } = validatedParams;

    if (!callbacks.onStream) {
      throw new Error(
        "onStream callback est requis pour le streaming des métriques"
      );
    }

    logger.debug("Début du streaming des métriques système", { interval });

    getCPUMetrics.lastTotals = null;
    getNetworkMetrics.lastIO = null;

    await collectAllMetrics();

    const cleanupFunctions = [];
    let isRunning = true;

    const collectInterval = setInterval(async () => {
      if (!isRunning) {
        return;
      }

      try {
        const metrics = await collectAllMetrics();
        callbacks.onStream("metrics", JSON.stringify(metrics));
      } catch (error) {
        logger.error("Erreur lors de la collecte des métriques", {
          error: error.message,
        });
      }
    }, interval * 1000);

    cleanupFunctions.push(() => {
      isRunning = false;
      clearInterval(collectInterval);
    });

    try {
      const initialMetrics = await collectAllMetrics();
      callbacks.onStream("metrics", JSON.stringify(initialMetrics));
    } catch (error) {
      logger.error("Erreur lors de la collecte initiale", {
        error: error.message,
      });
    }

    return {
      isStreaming: true,
      initialResponse: {
        stream: "metrics",
        mode: "metrics.stream",
        interval,
      },
      resource: {
        type: "metrics-stream",
        cleanup: () => {
          logger.debug("Nettoyage du collecteur de métriques");
          cleanupFunctions.forEach((cleanup) => {
            try {
              cleanup();
            } catch (error) {
              logger.warn("Erreur lors du nettoyage", {
                error: error.message,
              });
            }
          });
        },
      },
    };
  } catch (error) {
    logger.error("Erreur lors du streaming des métriques", {
      error: error.message,
    });
    throw error;
  }
}
