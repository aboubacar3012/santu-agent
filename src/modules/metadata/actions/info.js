/**
 * Action info - Récupère toutes les métadonnées statiques du serveur
 *
 * @module modules/metadata/actions/info
 */

import { logger } from "../../../shared/logger.js";
import { validateMetadataParams } from "../validator.js";
import {
  getHostname,
  parseOsRelease,
  getArchitecture,
  getCpuInfo,
  getMemoryInfo,
  getDiskInfo,
  getNetworkInfo,
  getSshPort,
} from "./utils.js";

/**
 * Récupère toutes les métadonnées statiques du serveur
 * @param {Object} params - Paramètres (non utilisés pour l'instant)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Métadonnées du serveur
 */
export async function getMetadata(params = {}, callbacks = {}) {
  try {
    validateMetadataParams("info", params);

    logger.debug("Début de la récupération des métadonnées du serveur");

    // Récupérer toutes les métadonnées en parallèle
    const [
      hostname,
      osInfo,
      architecture,
      cpuInfo,
      memoryTotal,
      diskTotal,
      networkIp,
      sshPort,
    ] = await Promise.all([
      getHostname(),
      Promise.resolve(parseOsRelease()),
      getArchitecture(),
      Promise.resolve(getCpuInfo()),
      getMemoryInfo(),
      getDiskInfo(),
      getNetworkInfo(),
      getSshPort(),
    ]);

    const metadata = {
      hostname: hostname,
      os: osInfo,
      architecture: architecture,
      cpu: cpuInfo,
      memory: {
        total: memoryTotal,
      },
      disk: {
        total: diskTotal,
      },
      network: {
        ip: networkIp,
        sshPort: sshPort,
      },
    };

    logger.info("Métadonnées du serveur récupérées avec succès", {
      hostname,
      architecture,
      cpuCores: cpuInfo.cores,
    });

    return metadata;
  } catch (error) {
    logger.error("Erreur lors de la récupération des métadonnées", {
      error: error.message,
    });
    throw error;
  }
}
