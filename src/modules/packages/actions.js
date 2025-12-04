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
 * Lit TOUS les packages installés depuis /var/lib/dpkg/status
 * Retourne tous les packages avec Status: install ok installed
 */
function listAllAptPackages() {
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

    console.log(
      `Lecture de /var/lib/dpkg/status (${content.length} caractères)`
    );

    const packages = [];
    let currentPackage = null;
    let isInstalled = false;

    for (const line of content.split("\n")) {
      const cleaned = line.trim();
      if (!cleaned) {
        // Fin d'un bloc package
        // Ajouter tous les packages installés (peu importe s'ils sont manuels ou automatiques)
        if (currentPackage && isInstalled) {
          packages.push(currentPackage);
        }
        currentPackage = null;
        isInstalled = false;
        continue;
      }

      if (cleaned.startsWith("Package:")) {
        currentPackage = cleaned.replace("Package:", "").trim();
      } else if (cleaned.startsWith("Status:")) {
        isInstalled = cleaned.includes("install ok installed");
      }
    }

    // Dernier package
    if (currentPackage && isInstalled) {
      packages.push(currentPackage);
    }

    console.log(`Packages installés trouvés: ${packages.length}`);
    if (packages.length > 0) {
      console.log(`Premiers packages: ${packages.slice(0, 10).join(", ")}`);
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
  const packages = listAllAptPackages();
  logger.info(`Packages installés détectés (APT): ${packages.length}`);

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
