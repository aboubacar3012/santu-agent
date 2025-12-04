import { logger } from "../../shared/logger.js";
import { executeCommand } from "../../shared/executor.js";
import { validatePackagesParams } from "./validator.js";

const SUPPORTED_MANAGERS = ["apt"];

async function parseOsRelease() {
  try {
    // Utiliser une commande shell pour lire /etc/os-release sur le serveur hôte
    // au lieu de le lire depuis le conteneur Alpine
    const { stdout, stderr, error } = await executeCommand(
      "cat /etc/os-release 2>/dev/null || echo ''",
      { timeout: 3000 }
    );

    if (error || !stdout || !stdout.trim()) {
      logger.debug("Impossible de lire /etc/os-release via commande shell", {
        error: error?.message,
        stderr,
      });
      return {};
    }

    const lines = stdout.split("\n");
    const data = {};
    for (const line of lines) {
      const cleaned = line.trim();
      if (!cleaned || cleaned.startsWith("#")) continue;
      const [key, value] = cleaned.split("=");
      if (!key || typeof value === "undefined") continue;
      data[key] = value.replace(/^"(.*)"$/, "$1");
    }
    return data;
  } catch (error) {
    logger.debug("Erreur lors de la lecture de /etc/os-release", {
      error: error.message,
    });
    return {};
  }
}

async function detectPackageManager() {
  const osInfo = await parseOsRelease();
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

async function runCommand(command) {
  const { stdout, stderr, error } = await executeCommand(command, {
    timeout: 5000,
  });
  if (error) {
    throw new Error(
      `Erreur lors de l'exécution de "${command}": ${stderr || error.message}`
    );
  }
  return stdout.trim();
}

async function listManualAptPackages() {
  // Utiliser le chemin complet vers apt-mark sur le serveur hôte
  const output = await runCommand(
    "/usr/bin/apt-mark showmanual 2>/dev/null || /bin/apt-mark showmanual 2>/dev/null || apt-mark showmanual"
  );
  return output
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
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

async function getInstallDate(pkgName) {
  try {
    const infoFile = `/var/lib/dpkg/info/${pkgName}.list`;
    // Utiliser stat via commande shell pour accéder au fichier sur le serveur hôte
    const { stdout, stderr, error } = await executeCommand(
      `stat -c %Y ${infoFile} 2>/dev/null || echo ''`,
      { timeout: 2000 }
    );

    if (error || !stdout || !stdout.trim()) {
      logger.debug(
        `Impossible de récupérer la date d'installation pour ${pkgName}`,
        {
          error: error?.message,
          stderr,
        }
      );
      return null;
    }

    const timestamp = parseInt(stdout.trim(), 10);
    if (isNaN(timestamp)) {
      return null;
    }

    return new Date(timestamp * 1000).toISOString();
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

async function getAptPackageDetails(pkgName) {
  try {
    // Utiliser le chemin complet vers dpkg-query sur le serveur hôte
    const version = await runCommand(
      `/usr/bin/dpkg-query -W -f='${"${Version}"}' ${pkgName} 2>/dev/null || /bin/dpkg-query -W -f='${"${Version}"}' ${pkgName} 2>/dev/null || dpkg-query -W -f='${"${Version}"}' ${pkgName}`
    );
    const size = await runCommand(
      `/usr/bin/dpkg-query -W -f='${"${Installed-Size}"}' ${pkgName} 2>/dev/null || /bin/dpkg-query -W -f='${"${Installed-Size}"}' ${pkgName} 2>/dev/null || dpkg-query -W -f='${"${Installed-Size}"}' ${pkgName}`
    );
    const installedDate = await getInstallDate(pkgName);

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

async function listAptPackages() {
  const packages = await listManualAptPackages();
  logger.info(`Packages utilisateur détectés (APT): ${packages.length}`);

  const details = [];

  for (const pkgName of packages) {
    const info = await getAptPackageDetails(pkgName);
    if (info) {
      details.push(info);
    }
  }

  return details;
}

export async function listPackages(params = {}, callbacks = {}) {
  validatePackagesParams("list", params);
  logger.debug("Début de la récupération des packages installés");

  const manager = await detectPackageManager();
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
