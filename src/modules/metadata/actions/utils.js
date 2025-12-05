/**
 * Utilitaires pour les actions Metadata
 *
 * Fonctions partagées utilisées par les actions Metadata.
 *
 * @module modules/metadata/actions/utils
 */

import { readFileSync, existsSync } from "fs";
import { logger } from "../../../shared/logger.js";
import { executeCommand } from "../../../shared/executor.js";

/**
 * Parse le fichier /etc/os-release pour récupérer les informations OS
 * @returns {Object} Informations OS (name, version, prettyName, id)
 */
export function parseOsRelease() {
  try {
    const osReleasePath = "/etc/os-release";

    if (!existsSync(osReleasePath)) {
      logger.error("Fichier /etc/os-release non trouvé");
      return null;
    }

    const content = readFileSync(osReleasePath, "utf-8");

    if (!content || typeof content !== "string") {
      logger.error("Contenu de /etc/os-release invalide ou vide");
      return null;
    }

    const lines = content.split("\n");
    const data = {};

    for (const line of lines) {
      const cleaned = line.trim();
      if (!cleaned || cleaned.startsWith("#")) continue;

      const equalIndex = cleaned.indexOf("=");
      if (equalIndex === -1) continue;

      const key = cleaned.substring(0, equalIndex).trim();
      let value = cleaned.substring(equalIndex + 1).trim();

      // Enlever les guillemets si présents
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (key && value) {
        data[key] = value;
      }
    }

    return {
      name: data.NAME || null,
      version: data.VERSION_ID || null,
      prettyName: data.PRETTY_NAME || null,
      id: data.ID || null,
    };
  } catch (error) {
    logger.error("Erreur lors de la lecture de /etc/os-release", {
      error: error.message,
    });
    return null;
  }
}

/**
 * Récupère le hostname du serveur
 * @returns {Promise<string|null>} Hostname ou null en cas d'erreur
 */
export async function getHostname() {
  try {
    // Essayer d'abord avec la commande hostname
    const { stdout } = await executeCommand("hostname", { timeout: 5000 });
    if (stdout && stdout.trim()) {
      return stdout.trim();
    }

    // Fallback: lire depuis /proc/sys/kernel/hostname
    if (existsSync("/proc/sys/kernel/hostname")) {
      const hostname = readFileSync("/proc/sys/kernel/hostname", "utf-8");
      return hostname.trim();
    }

    return null;
  } catch (error) {
    logger.error("Erreur lors de la récupération du hostname", {
      error: error.message,
    });
    return null;
  }
}

/**
 * Récupère l'architecture du système
 * @returns {Promise<string|null>} Architecture ou null en cas d'erreur
 */
export async function getArchitecture() {
  try {
    const { stdout } = await executeCommand("uname -m", { timeout: 5000 });
    if (stdout && stdout.trim()) {
      return stdout.trim();
    }
    return null;
  } catch (error) {
    logger.error("Erreur lors de la récupération de l'architecture", {
      error: error.message,
    });
    return null;
  }
}

/**
 * Parse /proc/cpuinfo pour récupérer les informations CPU
 * @returns {Object} Informations CPU (cores, model)
 */
export function getCpuInfo() {
  try {
    if (!existsSync("/proc/cpuinfo")) {
      logger.error("Fichier /proc/cpuinfo non trouvé");
      return { cores: null, model: null };
    }

    const content = readFileSync("/proc/cpuinfo", "utf-8");
    if (!content || typeof content !== "string") {
      return { cores: null, model: null };
    }

    const lines = content.split("\n");
    let cores = 0;
    let model = null;

    for (const line of lines) {
      const cleaned = line.trim();
      if (cleaned.startsWith("processor")) {
        cores++;
      } else if (cleaned.startsWith("model name")) {
        const colonIndex = cleaned.indexOf(":");
        if (colonIndex > -1 && !model) {
          model = cleaned.substring(colonIndex + 1).trim();
        }
      }
    }

    // Si aucun processeur trouvé, essayer de compter les cores physiques
    if (cores === 0) {
      const physicalIdMatches = content.match(/physical id\s*:\s*\d+/g);
      if (physicalIdMatches) {
        const uniquePhysicalIds = new Set(
          physicalIdMatches.map((match) => match.split(":")[1].trim())
        );
        cores = uniquePhysicalIds.size;
      }
    }

    return {
      cores: cores > 0 ? cores : null,
      model: model || null,
    };
  } catch (error) {
    logger.error("Erreur lors de la lecture de /proc/cpuinfo", {
      error: error.message,
    });
    return { cores: null, model: null };
  }
}

/**
 * Parse /proc/meminfo pour récupérer la RAM totale
 * @returns {Promise<number|null>} RAM totale en bytes ou null en cas d'erreur
 */
export async function getMemoryInfo() {
  try {
    if (!existsSync("/proc/meminfo")) {
      logger.error("Fichier /proc/meminfo non trouvé");
      return null;
    }

    const content = readFileSync("/proc/meminfo", "utf-8");
    if (!content || typeof content !== "string") {
      return null;
    }

    const lines = content.split("\n");
    for (const line of lines) {
      if (line.startsWith("MemTotal:")) {
        const match = line.match(/MemTotal:\s*(\d+)\s*kB/);
        if (match && match[1]) {
          // Convertir de KB en bytes
          const totalKb = parseInt(match[1], 10);
          return totalKb * 1024;
        }
      }
    }

    return null;
  } catch (error) {
    logger.error("Erreur lors de la lecture de /proc/meminfo", {
      error: error.message,
    });
    return null;
  }
}

/**
 * Récupère les informations de stockage via df
 * @returns {Promise<number|null>} Stockage total en bytes ou null en cas d'erreur
 */
export async function getDiskInfo() {
  try {
    const { stdout } = await executeCommand("df -B1 /", { timeout: 5000 });
    if (!stdout) {
      return null;
    }

    const lines = stdout.split("\n");
    // La deuxième ligne contient les informations du système de fichiers racine
    if (lines.length >= 2) {
      const parts = lines[1].trim().split(/\s+/);
      if (parts.length >= 2) {
        const totalBytes = parseInt(parts[1], 10);
        if (!isNaN(totalBytes)) {
          return totalBytes;
        }
      }
    }

    return null;
  } catch (error) {
    logger.error(
      "Erreur lors de la récupération des informations de stockage",
      {
        error: error.message,
      }
    );
    return null;
  }
}

/**
 * Récupère l'IP principale du serveur
 * @returns {Promise<string|null>} IP principale ou null en cas d'erreur
 */
export async function getNetworkInfo() {
  try {
    // Essayer d'abord avec hostname -I
    const { stdout } = await executeCommand("hostname -I | awk '{print $1}'", {
      timeout: 5000,
    });
    if (stdout && stdout.trim()) {
      const ip = stdout.trim();
      // Vérifier que ce n'est pas une IP loopback
      if (!ip.startsWith("127.") && ip !== "::1") {
        return ip;
      }
    }

    // Fallback: lire depuis /proc/net/route
    if (existsSync("/proc/net/route")) {
      const content = readFileSync("/proc/net/route", "utf-8");
      const lines = content.split("\n");
      // Chercher la première interface non-loopback avec une route par défaut
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].trim().split(/\s+/);
        if (parts.length >= 3 && parts[1] === "00000000") {
          // Route par défaut trouvée, maintenant récupérer l'IP de l'interface
          const iface = parts[0];
          const { stdout: ipOut } = await executeCommand(
            `ip addr show ${iface} | grep 'inet ' | awk '{print $2}' | cut -d/ -f1`,
            { timeout: 5000 }
          );
          if (ipOut && ipOut.trim()) {
            const ip = ipOut.trim();
            if (!ip.startsWith("127.") && ip !== "::1") {
              return ip;
            }
          }
        }
      }
    }

    return null;
  } catch (error) {
    logger.error("Erreur lors de la récupération de l'IP principale", {
      error: error.message,
    });
    return null;
  }
}

/**
 * Parse /etc/ssh/sshd_config pour récupérer le port SSH
 * @returns {Promise<number>} Port SSH (défaut: 22)
 */
export async function getSshPort() {
  try {
    const sshdConfigPath = "/etc/ssh/sshd_config";
    if (!existsSync(sshdConfigPath)) {
      logger.debug(
        "Fichier /etc/ssh/sshd_config non trouvé, utilisation du port par défaut 22"
      );
      return 22;
    }

    const content = readFileSync(sshdConfigPath, "utf-8");
    if (!content || typeof content !== "string") {
      return 22;
    }

    const lines = content.split("\n");
    for (const line of lines) {
      const cleaned = line.trim();
      // Ignorer les commentaires et les lignes vides
      if (!cleaned || cleaned.startsWith("#")) continue;

      // Chercher la directive Port (insensible à la casse)
      // Format attendu: "Port 53796" ou "port 53796" ou "PORT 53796"
      const portMatch = cleaned.match(/^port\s+(\d+)$/i);
      if (portMatch && portMatch[1]) {
        const port = parseInt(portMatch[1], 10);
        if (!isNaN(port) && port > 0 && port <= 65535) {
          logger.debug(`Port SSH trouvé dans sshd_config: ${port}`);
          return port;
        }
      }
    }

    // Port par défaut si non trouvé
    logger.debug(
      "Port SSH non trouvé dans sshd_config, utilisation du port par défaut 22"
    );
    return 22;
  } catch (error) {
    logger.error("Erreur lors de la lecture de /etc/ssh/sshd_config", {
      error: error.message,
    });
    return 22;
  }
}
