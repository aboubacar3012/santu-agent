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
 * Exécute une commande sur l'hôte via nsenter
 * @param {string} command - Commande à exécuter
 * @param {Object} [options] - Options d'exécution
 * @returns {Promise<Object>} Résultat de l'exécution
 */
async function executeHostCommand(command, options = {}) {
  const escapedCommand = command.replace(/'/g, "'\"'\"'");
  const nsenterCommand = `nsenter -t 1 -m -u -i -n -p -- sh -c '${escapedCommand}'`;

  return await executeCommand(nsenterCommand, {
    timeout: options.timeout || 5000,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
  });
}

/**
 * Récupère l'IP principale du serveur en utilisant nsenter pour accéder à l'hôte
 * @returns {Promise<string|null>} IP principale ou null en cas d'erreur
 */
export async function getNetworkInfo() {
  try {
    // Utiliser nsenter pour exécuter hostname -I dans l'espace de noms de l'hôte
    // Cela permet d'obtenir l'IP réelle du serveur et non celle du conteneur Docker
    const { stdout } = await executeHostCommand(
      "hostname -I | awk '{print $1}'",
      {
        timeout: 5000,
      }
    );
    if (stdout && stdout.trim()) {
      const ip = stdout.trim();
      // Vérifier que ce n'est pas une IP loopback
      if (!ip.startsWith("127.") && ip !== "::1") {
        logger.debug("IP principale récupérée via nsenter", { ip });
        return ip;
      }
    }

    // Fallback: utiliser ip addr via nsenter pour trouver l'IP de l'interface principale
    const { stdout: ipAddrOut } = await executeHostCommand(
      "ip addr show | grep 'inet ' | grep -v '127.0.0.1' | head -1 | awk '{print $2}' | cut -d/ -f1",
      { timeout: 5000 }
    );
    if (ipAddrOut && ipAddrOut.trim()) {
      const ip = ipAddrOut.trim();
      if (!ip.startsWith("127.") && ip !== "::1") {
        logger.debug("IP principale récupérée via ip addr (nsenter)", { ip });
        return ip;
      }
    }

    logger.warn(
      "Impossible de récupérer l'IP principale du serveur via nsenter"
    );
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

/**
 * Récupère le hostname depuis les certificats Let's Encrypt qui correspond au hostname du serveur
 * @param {string} [serverHostname] - Hostname du serveur pour trouver le bon certificat
 * @returns {Promise<string|null>} Hostname du certificat ou null si non trouvé/erreur
 */
export async function getCertificateHostname(serverHostname = null) {
  try {
    // Utiliser nsenter pour exécuter certbot certificates sur l'hôte
    const result = await executeHostCommand("certbot certificates", {
      timeout: 10000,
    });

    if (result.error || !result.stdout) {
      logger.debug("Impossible de récupérer les certificats Let's Encrypt", {
        error: result.error,
        stderr: result.stderr,
      });
      return null;
    }

    // Parser la sortie de certbot certificates
    // Format attendu:
    // Certificate Name: vps-old-dev-node-96938b8e.elyamaje.com
    //   Domains: vps-old-dev-node-96938b8e.elyamaje.com
    //   Expiry Date: 2026-02-15 12:34:56+00:00 (VALID: 30 days)
    //   Certificate Path: /etc/letsencrypt/live/vps-old-dev-node-96938b8e.elyamaje.com/fullchain.pem
    //   Private Key Path: /etc/letsencrypt/live/vps-old-dev-node-96938b8e.elyamaje.com/privkey.pem
    const lines = result.stdout.split("\n");
    let currentCertificate = null;
    let currentDomains = null;
    const certificates = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Chercher la ligne "Certificate Name:"
      if (line.startsWith("Certificate Name:")) {
        // Si on avait un certificat précédent, l'ajouter à la liste
        if (currentCertificate) {
          certificates.push({
            name: currentCertificate,
            domains: currentDomains || [],
          });
        }

        const match = line.match(/Certificate Name:\s*(.+)/);
        if (match && match[1]) {
          currentCertificate = match[1].trim();
          currentDomains = [];
        }
      }
      // Chercher la ligne "Domains:" qui liste les domaines du certificat
      else if (line.startsWith("Domains:") && currentCertificate) {
        const domainsMatch = line.match(/Domains:\s*(.+)/);
        if (domainsMatch && domainsMatch[1]) {
          // Les domaines peuvent être séparés par des espaces
          currentDomains = domainsMatch[1]
            .trim()
            .split(/\s+/)
            .map((d) => d.trim())
            .filter((d) => d.length > 0);
        }
      }
    }

    // Ajouter le dernier certificat trouvé
    if (currentCertificate) {
      certificates.push({
        name: currentCertificate,
        domains: currentDomains || [],
      });
    }

    // Si aucun certificat trouvé
    if (certificates.length === 0) {
      logger.debug("Aucun certificat Let's Encrypt trouvé");
      return null;
    }

    // Si un hostname de serveur est fourni, chercher le certificat qui correspond
    if (serverHostname) {
      const normalizedServerHostname = serverHostname.trim().toLowerCase();

      for (const cert of certificates) {
        // Vérifier si le nom du certificat contient le hostname
        const normalizedCertName = cert.name.toLowerCase();
        if (normalizedCertName.includes(normalizedServerHostname)) {
          logger.debug(
            "Certificat trouvé correspondant au hostname du serveur",
            {
              certificateHostname: cert.name,
              serverHostname: serverHostname,
              domains: cert.domains,
            }
          );
          return cert.name;
        }

        // Vérifier si un des domaines contient le hostname
        for (const domain of cert.domains) {
          const normalizedDomain = domain.toLowerCase();
          if (normalizedDomain.includes(normalizedServerHostname)) {
            logger.debug(
              "Certificat trouvé via domaine correspondant au hostname",
              {
                certificateHostname: cert.name,
                serverHostname: serverHostname,
                matchingDomain: domain,
                allDomains: cert.domains,
              }
            );
            return cert.name;
          }
        }
      }

      // Si aucun certificat ne correspond, logger un avertissement et retourner le premier
      logger.warn(
        "Aucun certificat ne correspond au hostname du serveur, utilisation du premier certificat",
        {
          serverHostname: serverHostname,
          availableCertificates: certificates.map((c) => c.name),
        }
      );
    }

    // Si aucun hostname fourni ou aucun match, retourner le premier certificat
    const firstCert = certificates[0];
    logger.debug("Hostname du certificat récupéré (premier trouvé)", {
      certificateHostname: firstCert.name,
      domains: firstCert.domains,
      serverHostname: serverHostname || "non fourni",
    });
    return firstCert.name;
  } catch (error) {
    logger.error("Erreur lors de la récupération du hostname du certificat", {
      error: error.message,
    });
    return null;
  }
}

/**
 * Valide que le hostname reçu correspond au serveur et que le certificat contient le hostname reçu
 * @param {string} receivedHostname - Hostname reçu (depuis le frontend)
 * @param {string} serverHostname - Hostname du serveur (via hostname)
 * @param {string} certificateHostname - Hostname du certificat Let's Encrypt
 * @returns {{valid: boolean, error?: string}} Résultat de la validation
 */
export function validateHostnameConsistency(
  receivedHostname,
  serverHostname,
  certificateHostname
) {
  // Normaliser les hostnames (trim et lowercase)
  const normalize = (hostname) => {
    if (!hostname) return null;
    return hostname.trim().toLowerCase();
  };

  const normalizedReceived = normalize(receivedHostname);
  const normalizedServer = normalize(serverHostname);
  const normalizedCertificate = normalize(certificateHostname);

  // Vérifier que tous les hostnames sont présents
  if (!normalizedReceived) {
    return {
      valid: false,
      error: "Hostname reçu manquant",
    };
  }

  if (!normalizedServer) {
    return {
      valid: false,
      error: "Hostname du serveur non disponible",
    };
  }

  // Vérifier que le hostname reçu correspond au hostname du serveur (correspondance exacte)
  if (normalizedReceived !== normalizedServer) {
    return {
      valid: false,
      error: `Incohérence des hostnames: reçu="${normalizedReceived}", serveur="${normalizedServer}"`,
    };
  }

  // Si le certificat n'est pas disponible, on accepte quand même la connexion
  // car la correspondance entre hostname reçu et serveur est suffisante
  if (!normalizedCertificate) {
    return {
      valid: true,
      // On retourne valid: true mais on peut logger un avertissement ailleurs
    };
  }

  // Si le certificat est disponible, vérifier qu'il contient le hostname reçu
  if (!normalizedCertificate.includes(normalizedReceived)) {
    return {
      valid: false,
      error: `Le certificat "${normalizedCertificate}" ne contient pas le hostname reçu "${normalizedReceived}"`,
    };
  }

  return {
    valid: true,
  };
}
