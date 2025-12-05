/**
 * Utilitaires pour les actions Docker
 *
 * Fonctions partagées utilisées par plusieurs actions Docker.
 *
 * @module modules/docker/actions/utils
 */

/**
 * Calcule le pourcentage CPU utilisé
 * @param {Object} stats - Statistiques Docker
 * @returns {number} Pourcentage CPU
 */
export function calculateCpuPercent(stats) {
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

export async function fetchContainerStatsSnapshot(docker, containerId) {
  const container = docker.getContainer(containerId);

  return new Promise((resolve, reject) => {
    container.stats({ stream: false }, (error, result) => {
      if (error) {
        reject(error);
        return;
      }

      try {
        if (Buffer.isBuffer(result)) {
          resolve(JSON.parse(result.toString()));
        } else {
          resolve(result);
        }
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

export function formatResourceUsage(stats) {
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

