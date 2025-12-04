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

    if (!content || typeof content !== "string") {
      logger.error("Contenu de /etc/os-release invalide ou vide");
      return {};
    }

    console.log("Contenu de /etc/os-release lu", {
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

    console.log("Données parsées depuis /etc/os-release", data);
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

  console.log("Détection de la distribution", { id, idLike, osInfo });

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

    if (!content || typeof content !== "string") {
      logger.debug(
        "Contenu de extended_states invalide ou vide, fallback vers status"
      );
      return listManualPackagesFromStatus();
    }

    logger.debug(
      `Lecture de /var/lib/apt/extended_states (${content.length} caractères)`
    );

    // Afficher un extrait du fichier pour debug
    const lines = content.split("\n");
    logger.debug(`Aperçu du fichier (premières lignes):`, {
      preview: lines.slice(0, 15).join("\n"),
    });

    const packages = [];
    let currentPackage = null;
    let totalParsed = 0;
    let manualCount = 0;
    let autoCount = 0;
    let samplePackages = []; // Pour logger quelques exemples

    for (const line of lines) {
      const cleaned = line.trim();
      if (!cleaned) {
        // Fin d'un bloc package
        if (currentPackage) {
          totalParsed++;
          if (currentPackage.manual) {
            manualCount++;
            packages.push(currentPackage.name);
            // Logger les premiers packages manuels pour debug
            if (samplePackages.length < 5) {
              samplePackages.push({
                name: currentPackage.name,
                autoInstalled: currentPackage.autoInstalledValue,
              });
            }
          } else {
            autoCount++;
          }
        }
        currentPackage = null;
        continue;
      }

      if (cleaned.startsWith("Package:")) {
        if (currentPackage) {
          totalParsed++;
          if (currentPackage.manual) {
            manualCount++;
            packages.push(currentPackage.name);
            if (samplePackages.length < 5) {
              samplePackages.push({
                name: currentPackage.name,
                autoInstalled: currentPackage.autoInstalledValue,
              });
            }
          } else {
            autoCount++;
          }
        }
        currentPackage = {
          name: cleaned.replace("Package:", "").trim(),
          manual: false,
          autoInstalledValue: null,
        };
      } else if (cleaned.startsWith("Architecture:")) {
        // Ignorer
      } else if (cleaned.startsWith("Auto-Installed:")) {
        const value = cleaned.replace("Auto-Installed:", "").trim();
        if (currentPackage) {
          currentPackage.autoInstalledValue = value;
          currentPackage.manual = value === "0";
        }
      }
    }

    // Dernier package
    if (currentPackage) {
      totalParsed++;
      if (currentPackage.manual) {
        manualCount++;
        packages.push(currentPackage.name);
        if (samplePackages.length < 5) {
          samplePackages.push({
            name: currentPackage.name,
            autoInstalled: currentPackage.autoInstalledValue,
          });
        }
      } else {
        autoCount++;
      }
    }

    logger.info(
      `Parsing terminé: ${totalParsed} packages parsés, ${manualCount} manuels, ${autoCount} automatiques`
    );
    logger.debug("Exemples de packages manuels:", samplePackages);
    if (packages.length > 0) {
      logger.debug(
        `Premiers packages manuels: ${packages.slice(0, 10).join(", ")}`
      );
    }

    return packages.sort();
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
 * Si Auto-Installed n'existe pas, le package est considéré comme manuel par défaut
 */
function listManualPackagesFromStatus() {
  try {
    const statusPath = "/var/lib/dpkg/status";
    if (!existsSync(statusPath)) {
      logger.error("Fichier /var/lib/dpkg/status non trouvé");
      return [];
    }

    const content = readFileSync(statusPath, "utf-8");

    if (!content || typeof content !== "string") {
      logger.error("Contenu de /var/lib/dpkg/status invalide ou vide");
      return [];
    }

    logger.debug(
      `Lecture de /var/lib/dpkg/status (${content.length} caractères)`
    );

    const packages = [];
    let currentPackage = null;
    let isInstalled = false;
    let hasAutoInstalled = false; // Indique si le champ Auto-Installed existe
    let isAutoInstalled = false;

    for (const line of content.split("\n")) {
      const cleaned = line.trim();
      if (!cleaned) {
        // Fin d'un bloc package
        // Un package est manuel s'il est installé ET (pas de champ Auto-Installed OU Auto-Installed: 0)
        if (currentPackage && isInstalled) {
          if (!hasAutoInstalled || !isAutoInstalled) {
            packages.push(currentPackage);
          }
        }
        currentPackage = null;
        isInstalled = false;
        hasAutoInstalled = false;
        isAutoInstalled = false;
        continue;
      }

      if (cleaned.startsWith("Package:")) {
        currentPackage = cleaned.replace("Package:", "").trim();
      } else if (cleaned.startsWith("Status:")) {
        isInstalled = cleaned.includes("install ok installed");
      } else if (cleaned.startsWith("Auto-Installed:")) {
        hasAutoInstalled = true;
        isAutoInstalled = cleaned.includes("1");
      }
    }

    // Dernier package
    if (currentPackage && isInstalled) {
      if (!hasAutoInstalled || !isAutoInstalled) {
        packages.push(currentPackage);
      }
    }

    logger.info(`Packages manuels trouvés depuis status: ${packages.length}`);
    if (packages.length > 0) {
      logger.debug(`Premiers packages: ${packages.slice(0, 10).join(", ")}`);
    }

    return packages.sort();
  } catch (error) {
    logger.error("Erreur lors de la lecture de /var/lib/dpkg/status", {
      error: error.message,
      stack: error.stack,
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
    // Essayer plusieurs fichiers pour obtenir la date d'installation
    const possibleFiles = [
      `/var/lib/dpkg/info/${pkgName}.list`,
      `/var/lib/dpkg/info/${pkgName}.md5sums`,
      `/var/lib/dpkg/info/${pkgName}.control`,
    ];

    for (const infoFile of possibleFiles) {
      if (existsSync(infoFile)) {
        const stats = statSync(infoFile);
        return new Date(stats.mtimeMs).toISOString();
      }
    }

    // Si aucun fichier n'existe, retourner null (c'est normal pour certains packages système)
    return null;
  } catch (error) {
    // Ne pas logger les erreurs pour les fichiers manquants (c'est normal)
    return null;
  }
}

/**
 * Parse le fichier status et retourne un Map avec tous les détails des packages
 * Cette fonction optimise en lisant le fichier une seule fois
 */
function parseAllPackageDetails() {
  try {
    const statusPath = "/var/lib/dpkg/status";
    if (!existsSync(statusPath)) {
      logger.error("Fichier /var/lib/dpkg/status non trouvé");
      return new Map();
    }

    const content = readFileSync(statusPath, "utf-8");
    if (!content || typeof content !== "string") {
      logger.error("Contenu de /var/lib/dpkg/status invalide ou vide");
      return new Map();
    }

    const packagesMap = new Map();
    const lines = content.split("\n");
    let currentPackage = null;
    let packageBlock = [];

    for (const line of lines) {
      const cleaned = line.trim();
      if (!cleaned) {
        // Fin d'un bloc package
        if (currentPackage && packageBlock.length > 0) {
          const blockText = packageBlock.join("\n");

          // Extraire version
          const versionMatch = blockText.match(/Version:\s*(.+)/);
          const version = versionMatch ? versionMatch[1].trim() : "unknown";

          // Extraire taille
          const sizeMatch = blockText.match(/Installed-Size:\s*(.+)/);
          const size = sizeMatch ? sizeMatch[1].trim() : "0";

          packagesMap.set(currentPackage, {
            name: currentPackage,
            version,
            size,
          });
        }
        currentPackage = null;
        packageBlock = [];
        continue;
      }

      if (cleaned.startsWith("Package:")) {
        currentPackage = cleaned.replace("Package:", "").trim();
        packageBlock = [cleaned];
      } else if (currentPackage) {
        packageBlock.push(cleaned);
      }
    }

    // Dernier package
    if (currentPackage && packageBlock.length > 0) {
      const blockText = packageBlock.join("\n");
      const versionMatch = blockText.match(/Version:\s*(.+)/);
      const version = versionMatch ? versionMatch[1].trim() : "unknown";
      const sizeMatch = blockText.match(/Installed-Size:\s*(.+)/);
      const size = sizeMatch ? sizeMatch[1].trim() : "0";

      packagesMap.set(currentPackage, {
        name: currentPackage,
        version,
        size,
      });
    }

    return packagesMap;
  } catch (error) {
    logger.error("Erreur lors du parsing de /var/lib/dpkg/status", {
      error: error.message,
    });
    return new Map();
  }
}

function listAptPackages() {
  const packages = listManualAptPackages();
  logger.info(`Packages utilisateur détectés (APT): ${packages.length}`);

  // Parser le fichier status une seule fois pour tous les packages
  const packagesDetailsMap = parseAllPackageDetails();
  logger.debug(`Détails parsés pour ${packagesDetailsMap.size} packages`);

  const details = [];

  for (const pkgName of packages) {
    const baseInfo = packagesDetailsMap.get(pkgName);
    if (!baseInfo) {
      // Si le package n'est pas dans le map, créer une entrée basique
      details.push({
        name: pkgName,
        version: "unknown",
        size: "0 KB",
        installedDate: getInstallDate(pkgName),
      });
      continue;
    }

    const installedDate = getInstallDate(pkgName);

    details.push({
      name: baseInfo.name,
      version: baseInfo.version || "unknown",
      size: formatSizeFromKb(baseInfo.size),
      installedDate,
    });
  }

  logger.info(`Détails complets récupérés pour ${details.length} packages`);
  return details;
}

export async function listPackages(params = {}, callbacks = {}) {
  validatePackagesParams("list", params);
  console.log("Début de la récupération des packages installés");

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
