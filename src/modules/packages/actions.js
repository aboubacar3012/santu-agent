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
    const infoFile = `/var/lib/dpkg/info/${pkgName}.list`;
    if (!existsSync(infoFile)) {
      console.log(`Fichier .list non trouvé pour ${pkgName}`);
      return null;
    }

    const stats = statSync(infoFile);
    return new Date(stats.mtimeMs).toISOString();
  } catch (error) {
    console.log(
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
      console.log(`Fichier status non trouvé pour ${pkgName}`);
      return null;
    }

    const content = readFileSync(statusPath, "utf-8");

    if (!content || typeof content !== "string") {
      console.log(`Contenu de status invalide ou vide pour ${pkgName}`);
      return null;
    }

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
    console.log(`Impossible de récupérer les détails du package ${pkgName}`, {
      error: error.message,
    });
    return null;
  }
}

function listAptPackages() {
  const packages = listAllAptPackages();
  logger.info(`Packages installés détectés (APT): ${packages.length}`);

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
