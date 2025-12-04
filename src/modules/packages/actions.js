import { readFileSync, existsSync, statSync } from "fs";
import { logger } from "../../shared/logger.js";
import { executeCommand } from "../../shared/executor.js";
import { validatePackagesParams } from "./validator.js";

const SUPPORTED_MANAGERS = ["apt"];

function parseOsRelease() {
  try {
    const content = readFileSync("/etc/os-release", "utf-8");
    const lines = content.split("\n");
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
    logger.debug("Impossible de lire /etc/os-release", {
      error: error.message,
    });
    return {};
  }
}

function detectPackageManager() {
  const osInfo = parseOsRelease();
  const id = (osInfo.ID || "").toLowerCase();
  const idLike = (osInfo.ID_LIKE || "").toLowerCase();

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
  const output = await runCommand("apt-mark showmanual");
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

function getInstallDate(pkgName) {
  try {
    const infoFile = `/var/lib/dpkg/info/${pkgName}.list`;
    if (!existsSync(infoFile)) {
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

async function getAptPackageDetails(pkgName) {
  try {
    const version = await runCommand(
      `dpkg-query -W -f='${"${Version}"}' ${pkgName}`
    );
    const size = await runCommand(
      `dpkg-query -W -f='${"${Installed-Size}"}' ${pkgName}`
    );

    return {
      name: pkgName,
      version: version || "unknown",
      size: formatSizeFromKb(size),
      installedDate: getInstallDate(pkgName),
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
