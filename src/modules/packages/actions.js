import { readFileSync, existsSync, statSync } from "fs";
import { logger } from "../../shared/logger.js";
import { executeCommand } from "../../shared/executor.js";
import { validatePackagesParams } from "./validator.js";

const SUPPORTED_MANAGERS = ["apt"];

function parseOsRelease() {
  try {
    const osReleasePath = "/etc/os-release";

    // Vérifier que le fichier existe
    if (!existsSync(osReleasePath)) {
      logger.error("Fichier /etc/os-release non trouvé (non monté ?)");
      return {};
    }

    // Lire /etc/os-release directement depuis le système de fichiers monté
    const content = readFileSync(osReleasePath, "utf-8");
    logger.debug("Contenu de /etc/os-release lu", {
      length: content.length,
      preview: content.substring(0, 200),
    });

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

    logger.debug("Données parsées depuis /etc/os-release", data);
    return data;
  } catch (error) {
    logger.error("Erreur lors de la lecture de /etc/os-release", {
      error: error.message,
      stack: error.stack,
    });
    return {};
  }
}

function detectPackageManager() {
  const osInfo = parseOsRelease();
  const id = (osInfo.ID || "").toLowerCase();
  const idLike = (osInfo.ID_LIKE || "").toLowerCase();

  logger.debug("Détection de la distribution", { id, idLike, osInfo });

  if (
    [id, idLike].some(
      (value) => value.includes("debian") || value.includes("ubuntu")
    )
  ) {
    return "apt";
  }

  throw new Error(
    `Distribution non supportée pour le module packages (ID=${id}, ID_LIKE=${
      idLike || "unknown"
    })`
  );
}

/**
 * Lit les packages installés manuellement depuis /var/lib/apt/extended_states
 * Ce fichier contient les packages marqués comme manuels (installés par l'utilisateur)
 */
function listManualAptPackages() {
  try {
    const extendedStatesPath = "/var/lib/apt/extended_states";
    if (!existsSync(extendedStatesPath)) {
      logger.debug("Fichier extended_states non trouvé, tentative avec status");
      // Fallback : lire depuis /var/lib/dpkg/status et filtrer les packages non-automatiques
      return listManualPackagesFromStatus();
    }

    const content = readFileSync(extendedStatesPath, "utf-8");
    const packages = [];
    let currentPackage = null;

    for (const line of content.split("\n")) {
      const cleaned = line.trim();
      if (!cleaned) continue;

      if (cleaned.startsWith("Package:")) {
        if (currentPackage) {
          packages.push(currentPackage);
        }
        currentPackage = {
          name: cleaned.replace("Package:", "").trim(),
          manual: false,
        };
      } else if (cleaned.startsWith("Architecture:")) {
        // Ignorer
      } else if (cleaned.startsWith("Auto-Installed:")) {
        const value = cleaned.replace("Auto-Installed:", "").trim();
        if (currentPackage) {
          currentPackage.manual = value === "0";
        }
      }
    }

    if (currentPackage) {
      packages.push(currentPackage);
    }

    return packages
      .filter((pkg) => pkg.manual)
      .map((pkg) => pkg.name)
      .sort();
  } catch (error) {
    logger.error("Erreur lors de la lecture des packages manuels", {
      error: error.message,
    });
    // Fallback vers status
    return listManualPackagesFromStatus();
  }
}

/**
 * Fallback : lire les packages depuis /var/lib/dpkg/status
 * Les packages avec Status: install ok installed et sans Auto-Installed: 1 sont considérés comme manuels
 */
function listManualPackagesFromStatus() {
  try {
    const statusPath = "/var/lib/dpkg/status";
    if (!existsSync(statusPath)) {
      logger.error("Fichier /var/lib/dpkg/status non trouvé");
      return [];
    }

    const content = readFileSync(statusPath, "utf-8");
    const packages = [];
    let currentPackage = null;
    let isInstalled = false;
    let isAutoInstalled = false;

    for (const line of content.split("\n")) {
      const cleaned = line.trim();
      if (!cleaned) {
        // Fin d'un bloc package
        if (currentPackage && isInstalled && !isAutoInstalled) {
          packages.push(currentPackage);
        }
        currentPackage = null;
        isInstalled = false;
        isAutoInstalled = false;
        continue;
      }

      if (cleaned.startsWith("Package:")) {
        currentPackage = cleaned.replace("Package:", "").trim();
      } else if (cleaned.startsWith("Status:")) {
        isInstalled = cleaned.includes("install ok installed");
      } else if (cleaned.startsWith("Auto-Installed:")) {
        isAutoInstalled = cleaned.includes("1");
      }
    }

    // Dernier package
    if (currentPackage && isInstalled && !isAutoInstalled) {
      packages.push(currentPackage);
    }

    return packages.sort();
  } catch (error) {
    logger.error("Erreur lors de la lecture de /var/lib/dpkg/status", {
      error: error.message,
    });
    return [];
  }
}

function formatSizeFromKb(sizeKb) {
  const size = Number(sizeKb);
  if (Number.isNaN(size) || size <= 0) {
    return "0 KB";
  }

  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(2)} GB`;
  }
  if (size >= 1024) {
    return `${(size / 1024).toFixed(2)} MB`;
  }
  return `${size} KB`;
}

function getInstallDate(pkgName) {
  try {
    const infoFile = `/var/lib/dpkg/info/${pkgName}.list`;
    if (!existsSync(infoFile)) {
      logger.debug(`Fichier .list non trouvé pour ${pkgName}`);
      return null;
    }

    const stats = statSync(infoFile);
    return new Date(stats.mtimeMs).toISOString();
  } catch (error) {
    logger.debug(
      `Impossible de récupérer la date d'installation pour ${pkgName}`,
      {
        error: error.message,
      }
    );
    return null;
  }
}

/**
 * Lit les détails d'un package depuis /var/lib/dpkg/status
 */
function getAptPackageDetails(pkgName) {
  try {
    const statusPath = "/var/lib/dpkg/status";
    if (!existsSync(statusPath)) {
      logger.debug(`Fichier status non trouvé pour ${pkgName}`);
      return null;
    }

    const content = readFileSync(statusPath, "utf-8");
    let version = "unknown";
    let size = "0";

    // Parser le fichier status pour trouver le package
    const lines = content.split("\n");
    let inPackage = false;
    let packageBlock = [];

    for (const line of lines) {
      const cleaned = line.trim();
      if (!cleaned) {
        // Fin d'un bloc
        if (inPackage) {
          // Parser le bloc
          const blockText = packageBlock.join("\n");
          if (blockText.includes(`Package: ${pkgName}`)) {
            // Extraire version
            const versionMatch = blockText.match(/Version:\s*(.+)/);
            if (versionMatch) {
              version = versionMatch[1].trim();
            }

            // Extraire taille
            const sizeMatch = blockText.match(/Installed-Size:\s*(.+)/);
            if (sizeMatch) {
              size = sizeMatch[1].trim();
            }
            break;
          }
          inPackage = false;
          packageBlock = [];
        }
        continue;
      }

      if (cleaned.startsWith("Package:")) {
        if (inPackage) {
          // Nouveau package, parser l'ancien
          const blockText = packageBlock.join("\n");
          if (blockText.includes(`Package: ${pkgName}`)) {
            const versionMatch = blockText.match(/Version:\s*(.+)/);
            if (versionMatch) {
              version = versionMatch[1].trim();
            }
            const sizeMatch = blockText.match(/Installed-Size:\s*(.+)/);
            if (sizeMatch) {
              size = sizeMatch[1].trim();
            }
            break;
          }
          packageBlock = [];
        }
        inPackage = true;
        packageBlock.push(cleaned);
      } else if (inPackage) {
        packageBlock.push(cleaned);
      }
    }

    // Vérifier le dernier bloc si nécessaire
    if (inPackage && packageBlock.length > 0) {
      const blockText = packageBlock.join("\n");
      if (blockText.includes(`Package: ${pkgName}`)) {
        const versionMatch = blockText.match(/Version:\s*(.+)/);
        if (versionMatch) {
          version = versionMatch[1].trim();
        }
        const sizeMatch = blockText.match(/Installed-Size:\s*(.+)/);
        if (sizeMatch) {
          size = sizeMatch[1].trim();
        }
      }
    }

    const installedDate = getInstallDate(pkgName);

    return {
      name: pkgName,
      version: version || "unknown",
      size: formatSizeFromKb(size),
      installedDate,
    };
  } catch (error) {
    logger.debug(`Impossible de récupérer les détails du package ${pkgName}`, {
      error: error.message,
    });
    return null;
  }
}

function listAptPackages() {
  const packages = listManualAptPackages();
  logger.info(`Packages utilisateur détectés (APT): ${packages.length}`);

  const details = [];

  for (const pkgName of packages) {
    const info = getAptPackageDetails(pkgName);
    if (info) {
      details.push(info);
    }
  }

  return details;
}

export async function listPackages(params = {}, callbacks = {}) {
  validatePackagesParams("list", params);
  logger.debug("Début de la récupération des packages installés");

  const manager = detectPackageManager();
  if (!SUPPORTED_MANAGERS.includes(manager)) {
    throw new Error(`Gestionnaire de packages non supporté: ${manager}`);
  }

  switch (manager) {
    case "apt":
      return listAptPackages();
    default:
      throw new Error(`Gestionnaire de packages non supporté: ${manager}`);
  }
}
