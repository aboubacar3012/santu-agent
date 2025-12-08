/**
 * Action stream - Collecte les métriques système en temps réel
 *
 * @module modules/metrics/actions/stream
 */

import { logger } from "../../../shared/logger.js";
import { validateMetricsParams } from "../validator.js";
import { executeCommand } from "../../../shared/executor.js";

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
 */
async function getCPUMetrics() {
  try {
    // Obtenir l'utilisation CPU via /proc/stat
    const { stdout: statOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- cat /proc/stat | head -1",
      { timeout: 5000 }
    );

    if (!statOutput) {
      return getDefaultCPUMetrics();
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

    // Calculer le pourcentage (on stocke les totaux pour le calcul suivant)
    if (!getCPUMetrics.lastTotals) {
      getCPUMetrics.lastTotals = { total, idle };
      // Attendre un peu pour avoir une mesure fiable
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return getDefaultCPUMetrics();
    }

    const totalDiff = total - getCPUMetrics.lastTotals.total;
    const idleDiff = idle - getCPUMetrics.lastTotals.idle;

    getCPUMetrics.lastTotals = { total, idle };

    let cpuUsage = 0;
    if (totalDiff > 0) {
      cpuUsage = ((totalDiff - idleDiff) / totalDiff) * 100;
      cpuUsage = Math.round(cpuUsage * 100) / 100;
    }

    // Obtenir le nombre de cœurs
    const { stdout: cpuCountOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- nproc",
      { timeout: 5000 }
    );
    const cpuCores = cpuCountOutput
      ? parseInt(cpuCountOutput.trim(), 10)
      : null;

    // Obtenir la fréquence CPU
    let cpuFreq = null;
    try {
      const { stdout: freqOutput } = await executeCommand(
        "nsenter -t 1 -m -u -i -n -p -- cat /proc/cpuinfo | grep 'cpu MHz' | head -1 | awk '{print $4}'",
        { timeout: 5000 }
      );
      if (freqOutput) {
        cpuFreq = parseFloat(freqOutput.trim());
      }
    } catch (error) {
      // Ignorer les erreurs de fréquence
    }

    // Obtenir la charge moyenne
    const { stdout: loadavgOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- cat /proc/loadavg",
      { timeout: 5000 }
    );

    let loadAvg1 = null;
    let loadAvg5 = null;
    let loadAvg15 = null;
    let loadPercent1 = null;
    let loadPercent5 = null;
    let loadPercent15 = null;

    if (loadavgOutput) {
      const loadParts = loadavgOutput.trim().split(/\s+/);
      loadAvg1 = parseFloat(loadParts[0]) || null;
      loadAvg5 = parseFloat(loadParts[1]) || null;
      loadAvg15 = parseFloat(loadParts[2]) || null;

      // Calculer les pourcentages de charge
      if (cpuCores && loadAvg1 !== null) {
        loadPercent1 = Math.min(
          Math.round((loadAvg1 / cpuCores) * 100 * 100) / 100,
          999.99
        );
      }
      if (cpuCores && loadAvg5 !== null) {
        loadPercent5 = Math.min(
          Math.round((loadAvg5 / cpuCores) * 100 * 100) / 100,
          999.99
        );
      }
      if (cpuCores && loadAvg15 !== null) {
        loadPercent15 = Math.min(
          Math.round((loadAvg15 / cpuCores) * 100 * 100) / 100,
          999.99
        );
      }
    }

    return {
      usage: cpuUsage,
      cores: cpuCores,
      frequency: cpuFreq,
      loadAvg1,
      loadAvg5,
      loadAvg15,
      loadPercent1,
      loadPercent5,
      loadPercent15,
    };
  } catch (error) {
    logger.debug("Erreur collecte métriques CPU", { error: error.message });
    return getDefaultCPUMetrics();
  }
}

function getDefaultCPUMetrics() {
  return {
    usage: 0,
    cores: null,
    frequency: null,
    loadAvg1: null,
    loadAvg5: null,
    loadAvg15: null,
    loadPercent1: null,
    loadPercent5: null,
    loadPercent15: null,
  };
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
      return getDefaultMemoryMetrics();
    }

    const lines = stdout.split("\n");
    const memLine = lines[1]; // Ligne Mem:
    const swapLine = lines[2]; // Ligne Swap:

    if (!memLine) {
      return getDefaultMemoryMetrics();
    }

    const memParts = memLine.trim().split(/\s+/);
    const total = parseInt(memParts[1], 10) || 0;
    const used = parseInt(memParts[2], 10) || 0;
    const free = parseInt(memParts[3], 10) || 0;
    const available = parseInt(memParts[6], 10) || free;
    const percent =
      total > 0 ? Math.round((used / total) * 100 * 100) / 100 : 0;

    // Métriques swap
    let swapTotal = null;
    let swapUsed = null;
    let swapPercent = null;

    if (swapLine) {
      const swapParts = swapLine.trim().split(/\s+/);
      swapTotal = parseInt(swapParts[1], 10) || null;
      swapUsed = parseInt(swapParts[2], 10) || null;

      if (swapTotal && swapTotal > 0 && swapUsed !== null) {
        swapPercent = Math.round((swapUsed / swapTotal) * 100 * 100) / 100;
      }
    }

    return {
      total: safeFloat(total),
      used: safeFloat(used),
      free: safeFloat(available),
      percent,
      swapTotal: safeFloat(swapTotal),
      swapUsed: safeFloat(swapUsed),
      swapPercent,
    };
  } catch (error) {
    logger.debug("Erreur collecte métriques mémoire", { error: error.message });
    return getDefaultMemoryMetrics();
  }
}

function getDefaultMemoryMetrics() {
  return {
    total: safeFloat(0),
    used: safeFloat(0),
    free: safeFloat(0),
    percent: 0,
    swapTotal: null,
    swapUsed: null,
    swapPercent: null,
  };
}

/**
 * Obtient les métriques disque
 */
async function getDiskMetrics() {
  try {
    // Utilisation de l'espace disque
    const { stdout: dfOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- df -B1 / | tail -1",
      { timeout: 5000 }
    );

    let total = null;
    let used = null;
    let free = null;
    let percent = 0;

    if (dfOutput) {
      const parts = dfOutput.trim().split(/\s+/);
      total = parseInt(parts[1], 10) || null;
      used = parseInt(parts[2], 10) || null;
      free = parseInt(parts[3], 10) || null;

      if (total && total > 0 && used !== null) {
        percent = Math.round((used / total) * 100 * 100) / 100;
      }
    }

    // I/O disque
    const { stdout: iostatOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- cat /proc/diskstats | head -1",
      { timeout: 5000 }
    );

    let readRate = null;
    let writeRate = null;
    let iops = null;

    if (iostatOutput) {
      const parts = iostatOutput.trim().split(/\s+/);
      // Les colonnes 3 et 7 sont les secteurs lus et écrits
      const sectorsRead = parseInt(parts[5], 10) || 0;
      const sectorsWritten = parseInt(parts[9], 10) || 0;
      const reads = parseInt(parts[3], 10) || 0;
      const writes = parseInt(parts[7], 10) || 0;

      // Calculer les taux (on stocke les valeurs précédentes)
      const now = Date.now();
      if (getDiskMetrics.lastIO) {
        const timeDelta = (now - getDiskMetrics.lastIO.time) / 1000; // en secondes
        if (timeDelta > 0) {
          const sectorsReadDelta =
            sectorsRead - getDiskMetrics.lastIO.sectorsRead;
          const sectorsWrittenDelta =
            sectorsWritten - getDiskMetrics.lastIO.sectorsWritten;
          // Un secteur = 512 bytes typiquement
          readRate = (sectorsReadDelta * 512) / timeDelta;
          writeRate = (sectorsWrittenDelta * 512) / timeDelta;
          readRate = Math.round(readRate * 100) / 100;
          writeRate = Math.round(writeRate * 100) / 100;

          // Calculer les IOPS (delta des opérations de lecture/écriture)
          const totalIOPS = reads + writes;
          const lastTotalIOPS =
            getDiskMetrics.lastIO.reads + getDiskMetrics.lastIO.writes;
          const iopsDelta = totalIOPS - lastTotalIOPS;
          iops = Math.round(iopsDelta / timeDelta);
        }
      }

      // Stocker les valeurs pour le prochain calcul
      getDiskMetrics.lastIO = {
        time: now,
        sectorsRead,
        sectorsWritten,
        reads,
        writes,
      };
    }

    return {
      total: safeFloat(total),
      used: safeFloat(used),
      free: safeFloat(free),
      percent,
      readRate: readRate !== null ? Math.round(readRate * 100) / 100 : null,
      writeRate: writeRate !== null ? Math.round(writeRate * 100) / 100 : null,
      iops: safeFloat(iops),
    };
  } catch (error) {
    logger.debug("Erreur collecte métriques disque", { error: error.message });
    return getDefaultDiskMetrics();
  }
}

function getDefaultDiskMetrics() {
  return {
    total: safeFloat(0),
    used: safeFloat(0),
    free: safeFloat(0),
    percent: 0,
    readRate: null,
    writeRate: null,
    iops: null,
  };
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
      return getDefaultNetworkMetrics();
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

    // Calculer les taux
    const now = Date.now();
    let rxRate = null;
    let txRate = null;

    if (getNetworkMetrics.lastIO) {
      const timeDelta = (now - getNetworkMetrics.lastIO.time) / 1000; // en secondes
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
      rxTotal: safeFloat(rxTotal),
      txTotal: safeFloat(txTotal),
    };
  } catch (error) {
    logger.debug("Erreur collecte métriques réseau", { error: error.message });
    return getDefaultNetworkMetrics();
  }
}

function getDefaultNetworkMetrics() {
  return {
    rxRate: null,
    txRate: null,
    rxTotal: null,
    txTotal: null,
  };
}

/**
 * Obtient les informations système
 */
async function getSystemInfo() {
  try {
    // Hostname
    const { stdout: hostnameOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- hostname",
      { timeout: 5000 }
    );
    const hostname = hostnameOutput ? hostnameOutput.trim() : "unknown";

    // Uptime
    const { stdout: uptimeOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- cat /proc/uptime | awk '{print $1}'",
      { timeout: 5000 }
    );
    const uptime = uptimeOutput ? parseFloat(uptimeOutput.trim()) : null;

    // Boot time
    let bootTime = null;
    try {
      const { stdout: btimeOutput } = await executeCommand(
        "nsenter -t 1 -m -u -i -n -p -- stat -c %Y /proc/1",
        { timeout: 5000 }
      );
      if (btimeOutput) {
        const bootTimestamp = parseInt(btimeOutput.trim(), 10);
        bootTime = new Date(bootTimestamp * 1000).toISOString();
      }
    } catch (error) {
      // Ignorer les erreurs
    }

    // Nombre de processus
    const { stdout: procCountOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- ps -e | wc -l",
      { timeout: 5000 }
    );
    const processes = procCountOutput
      ? parseInt(procCountOutput.trim(), 10)
      : null;

    // OS name
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
      // Fallback
      const { stdout: unameOutput } = await executeCommand(
        "nsenter -t 1 -m -u -i -n -p -- uname -a",
        { timeout: 5000 }
      );
      if (unameOutput) {
        osName = unameOutput.trim();
      }
    }

    // OS version
    const { stdout: osVersionOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- uname -r",
      { timeout: 5000 }
    );
    const osVersion = osVersionOutput ? osVersionOutput.trim() : null;

    // Architecture
    const { stdout: archOutput } = await executeCommand(
      "nsenter -t 1 -m -u -i -n -p -- uname -m",
      { timeout: 5000 }
    );
    const architecture = archOutput ? archOutput.trim() : null;

    return {
      hostname,
      uptime: safeFloat(uptime),
      bootTime,
      processes,
      osName,
      osVersion: osVersion ? `${osName || "Linux"} ${osVersion}` : null,
      architecture,
    };
  } catch (error) {
    logger.debug("Erreur collecte infos système", { error: error.message });
    return {
      hostname: "unknown",
      uptime: null,
      bootTime: null,
      processes: null,
      osName: null,
      osVersion: null,
      architecture: null,
    };
  }
}

/**
 * Obtient les top processus
 */
async function getTopProcesses(limit = 10) {
  try {
    const { stdout } = await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- ps aux --sort=-%cpu | head -${
        limit + 1
      } | tail -${limit}`,
      { timeout: 5000 }
    );

    if (!stdout) {
      return [];
    }

    const processes = [];
    const lines = stdout.split("\n").filter((l) => l.trim());

    // Processus système à exclure
    const systemProcesses = [
      "systemd",
      "kthreadd",
      "rcu_gp",
      "kworker",
      "ksoftirqd",
      "migration",
      "watchdog",
    ];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 11) {
        const procName = parts[10] || "";
        const isSystemProcess = systemProcesses.some((sp) =>
          procName.toLowerCase().includes(sp.toLowerCase())
        );

        if (!isSystemProcess) {
          const cpuPercent = parseFloat(parts[2]) || 0;
          const memPercent = parseFloat(parts[3]) || 0;

          // Filtrer les processus avec utilisation significative
          if (cpuPercent > 0.5 || memPercent > 1.0) {
            const cmdline = parts.slice(10).join(" ").substring(0, 100);
            processes.push({
              pid: parseInt(parts[1], 10),
              name: procName,
              cmdline,
              cpuPercent: Math.round(cpuPercent * 100) / 100,
              memoryPercent: Math.round(memPercent * 100) / 100,
              username: parts[0],
              status: parts[7] || "R",
            });
          }
        }
      }
    }

    // Trier par utilisation combinée
    processes.sort(
      (a, b) =>
        b.cpuPercent + b.memoryPercent - (a.cpuPercent + a.memoryPercent)
    );

    return processes.slice(0, limit);
  } catch (error) {
    logger.debug("Erreur collecte top processus", { error: error.message });
    return [];
  }
}

/**
 * Collecte toutes les métriques système
 */
async function collectAllMetrics() {
  try {
    const timestamp = new Date().toISOString();

    // Collecter toutes les métriques en parallèle
    const [
      cpuMetrics,
      memoryMetrics,
      diskMetrics,
      networkMetrics,
      systemInfo,
      topProcesses,
    ] = await Promise.all([
      getCPUMetrics(),
      getMemoryMetrics(),
      getDiskMetrics(),
      getNetworkMetrics(),
      getSystemInfo(),
      getTopProcesses(10),
    ]);

    const payload = {
      hostname: systemInfo.hostname,
      timestamp,
      metrics: {
        // CPU metrics
        cpuUsage: cpuMetrics.usage,
        cpuCores: cpuMetrics.cores,
        cpuFreq: cpuMetrics.frequency,
        loadAvg1: cpuMetrics.loadAvg1,
        loadAvg5: cpuMetrics.loadAvg5,
        loadAvg15: cpuMetrics.loadAvg15,
        loadPercent1: cpuMetrics.loadPercent1,
        loadPercent5: cpuMetrics.loadPercent5,
        loadPercent15: cpuMetrics.loadPercent15,

        // Memory metrics
        memoryTotal: memoryMetrics.total,
        memoryUsed: memoryMetrics.used,
        memoryFree: memoryMetrics.free,
        memoryPercent: memoryMetrics.percent,
        swapTotal: memoryMetrics.swapTotal,
        swapUsed: memoryMetrics.swapUsed,
        swapPercent: memoryMetrics.swapPercent,

        // Disk metrics
        diskTotal: diskMetrics.total,
        diskUsed: diskMetrics.used,
        diskFree: diskMetrics.free,
        diskPercent: diskMetrics.percent,
        diskReadRate: diskMetrics.readRate,
        diskWriteRate: diskMetrics.writeRate,
        diskIOPS: diskMetrics.iops,

        // Network metrics
        networkRxRate: networkMetrics.rxRate,
        networkTxRate: networkMetrics.txRate,
        networkRxTotal: networkMetrics.rxTotal,
        networkTxTotal: networkMetrics.txTotal,

        // System info
        uptime: systemInfo.uptime,
        bootTime: systemInfo.bootTime,
        processes: systemInfo.processes,
        processesList: topProcesses,
        osName: systemInfo.osName,
        osVersion: systemInfo.osVersion,
        architecture: systemInfo.architecture,

        // Additional metrics
        additionalMetrics: {
          agentVersion: "1.0.0",
          nodeVersion: process.version,
        },
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
    const validatedParams = validateMetricsParams("stream", params);
    const { interval } = validatedParams;

    if (!callbacks.onStream) {
      throw new Error(
        "onStream callback est requis pour le streaming des métriques"
      );
    }

    logger.debug("Début du streaming des métriques système", { interval });

    // Initialiser les états pour les calculs de taux
    getCPUMetrics.lastTotals = null;
    getDiskMetrics.lastIO = null;
    getNetworkMetrics.lastIO = null;

    // Première collecte pour initialiser les états
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

    // Collecte immédiate
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
              logger.warn("Erreur lors du nettoyage", { error: error.message });
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
