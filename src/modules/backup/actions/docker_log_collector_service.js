#!/usr/bin/env node
/**
 * ###############################################################################
 * SERVICE: Collecte et upload des logs Docker vers AWS S3
 *
 * DESCRIPTION:
 * Ce script collecte automatiquement les logs de tous les containers Docker
 * et les upload vers un bucket S3 AWS pour archivage et sauvegarde.
 *
 * FONCTIONNEMENT:
 * 1. COLLECTE DES LOGS (toutes les 2 minutes):
 *    - Copie les fichiers de logs JSON Docker (*-json.log) vers des fichiers temporaires
 *    - Manipule seulement les fichiers temporaires pour éviter de toucher aux originaux
 *    - Parse les logs JSON pour séparer stdout et stderr
 *    - Collecte uniquement les logs des 2 dernières minutes
 *    - Accumule les logs dans des fichiers temporaires par heure:
 *      * container/date/10h00min_all.log (tous les logs de 10h00 à 10h59)
 *      * container/date/10h00min_errors.log (seulement les stderr de 10h00 à 10h59)
 *    - Utilise l'heure de Paris (UTC+1/UTC+2)
 *
 * 2. UPLOAD VERS S3 (toutes les heures):
 *    - Upload seulement au début de chaque heure (dans les 2 premières minutes)
 *    - Upload les fichiers temporaires de l'heure précédente
 *    - Compresse les logs en .log.gz
 *    - Upload vers S3 avec structure: env/container/date/heure.log.gz
 *    - Supprime les fichiers locaux après upload réussi
 *
 * 3. NETTOYAGE:
 *    - Supprime les fichiers temporaires créés lors de la collecte
 *    - Nettoie les fichiers temporaires de l'heure précédente après upload
 *
 * STRUCTURE S3 FINALE:
 * s3://elyamaje-log-files/prod/
 * ├── elyamajeplay-backend/
 * │   └── 2025-01-27/
 * │       ├── 11h00min_all.log.gz
 * │       ├── 11h00min_errors.log.gz
 * │       ├── 12h00min_all.log.gz
 * │       └── 12h00min_errors.log.gz
 * └── elyamajeplay-dashboard/
 *     └── 2025-01-27/
 *         ├── 12h00min_all.log.gz
 *         └── 12h00min_errors.log.gz
 *
 * VARIABLES:
 * - env: prod (environnement: dev, sandbox, prod)
 * - log_base_dir: /tmp/docker-logs (répertoire de collecte)
 * - aws_env_file: /etc/._4d8f2.sh (fichier d'environnement AWS)
 *
 * USAGE:
 * - Exécution manuelle: node docker_log_collector_service.js --env prod
 * - Via cron: toutes les 2 minutes (format cron: toutes les 2 minutes)
 * - Logs: /var/log/docker-log-collector.log
 *
 * DÉPENDANCES:
 * - @aws-sdk/client-s3
 *
 * SORTIE:
 * - Logs collectés et uploadés vers S3
 * - Fichiers temporaires nettoyés
 * - Logs détaillés dans /var/log/docker-log-collector.log
 * ###############################################################################
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
  copyFileSync,
  createWriteStream,
} from "fs";
import { join, dirname } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { createReadStream } from "fs";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// Logger simple pour le script standalone
const logFile = "/var/log/docker-log-collector.log";
function log(level, message, ...args) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message} ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : a)).join(" ")}\n`;

  // Écrire dans le fichier de log
  try {
    appendFileSync(logFile, logMessage, "utf-8");
  } catch (error) {
    // Si on ne peut pas écrire dans le fichier, afficher sur stderr
    console.error(logMessage);
  }

  // Aussi afficher sur stdout pour le cron
  if (level === "ERROR" || level === "WARN") {
    console.error(logMessage.trim());
  } else {
    console.log(logMessage.trim());
  }
}

const logger = {
  info: (msg, ...args) => log("INFO", msg, ...args),
  warn: (msg, ...args) => log("WARN", msg, ...args),
  error: (msg, ...args) => log("ERROR", msg, ...args),
  debug: (msg, ...args) => log("DEBUG", msg, ...args),
};

const execAsync = promisify(exec);

class DockerLogCollectorService {
  constructor(env = "sandbox") {
    this.env = env;
    this.log_base_dir = "/tmp/docker-logs";
    this.docker_log_dir = "/var/lib/docker/containers";
    this.aws_env_file = "/etc/._4d8f2.sh";

    // Charger les variables AWS
    this.loadAwsCredentials();

    // Initialiser le client S3
    this.s3Client = new S3Client({
      region: this.aws_region,
      credentials: {
        accessKeyId: this.aws_access_key_id,
        secretAccessKey: this.aws_secret_access_key,
      },
    });
  }

  getParisTime() {
    /**Retourne un objet avec les composants de date/heure à Paris*/
    const now = new Date();
    // Utiliser Intl.DateTimeFormat pour obtenir les composants de date/heure à Paris
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const getPart = (type) => parts.find((p) => p.type === type)?.value || "0";

    return {
      year: parseInt(getPart("year")),
      month: parseInt(getPart("month")),
      day: parseInt(getPart("day")),
      hour: parseInt(getPart("hour")),
      minute: parseInt(getPart("minute")),
      second: parseInt(getPart("second")),
      // Méthodes pour compatibilité
      getHours: () => parseInt(getPart("hour")),
      getMinutes: () => parseInt(getPart("minute")),
      getUTCHours: () => parseInt(getPart("hour")),
      getUTCMinutes: () => parseInt(getPart("minute")),
      getUTCFullYear: () => parseInt(getPart("year")),
      getUTCMonth: () => parseInt(getPart("month")) - 1,
      getUTCDate: () => parseInt(getPart("day")),
      setUTCHours: function (h) {
        this.hour = h;
      },
      setUTCMinutes: function (m) {
        this.minute = m;
      },
      setUTCDate: function (d) {
        this.day = d;
      },
      toISOString: () => {
        const y = getPart("year");
        const m = getPart("month");
        const d = getPart("day");
        return `${y}-${m}-${d}`;
      },
    };
  }

  loadAwsCredentials() {
    /**Charge les credentials AWS depuis le fichier d'environnement*/
    try {
      if (existsSync(this.aws_env_file)) {
        const content = readFileSync(this.aws_env_file, "utf-8");
        const lines = content.split("\n");

        for (const line of lines) {
          if (line.startsWith("export ")) {
            const cleaned = line.replace("export ", "").trim();
            const [key, ...valueParts] = cleaned.split("=");
            const value = valueParts.join("=").trim().replace(/^"|"$/g, "");

            if (key === "AWS_ACCESS_KEY_ID") {
              this.aws_access_key_id = value;
            } else if (key === "AWS_SECRET_ACCESS_KEY") {
              this.aws_secret_access_key = value;
            } else if (key === "AWS_REGION") {
              this.aws_region = value;
            } else if (key === "AWS_LOGS_BUCKET") {
              this.aws_logs_bucket = value;
            }
          }
        }

        // Vérifier que toutes les variables requises sont définies
        const requiredVars = [
          "aws_access_key_id",
          "aws_secret_access_key",
          "aws_region",
          "aws_logs_bucket",
        ];
        const missingVars = requiredVars.filter((varName) => !this[varName]);

        if (missingVars.length > 0) {
          logger.error(`Variables AWS manquantes: ${missingVars.join(", ")}`);
          process.exit(1);
        }
      } else {
        logger.error(
          `Fichier d'environnement AWS non trouvé: ${this.aws_env_file}`,
        );
        process.exit(1);
      }
    } catch (error) {
      logger.error(
        `Erreur lors du chargement des credentials AWS: ${error.message}`,
      );
      process.exit(1);
    }
  }

  async collectDockerLogs() {
    /**Collecte les logs de tous les containers Docker des 2 dernières minutes et les accumule dans des fichiers temporaires par heure*/
    try {
      // Créer le répertoire de base
      if (!existsSync(this.log_base_dir)) {
        mkdirSync(this.log_base_dir, { recursive: true });
      }

      // Obtenir la date et heure actuelles à Paris
      const now = this.getParisTime();
      const year = now.getUTCFullYear();
      const month = String(now.getUTCMonth() + 1).padStart(2, "0");
      const day = String(now.getUTCDate()).padStart(2, "0");
      const hour = String(now.getUTCHours()).padStart(2, "0");
      const dateStr = `${year}-${month}-${day}`; // YYYY-MM-DD
      // Utiliser l'heure complète (ex: 10h00min) pour le nom du fichier temporaire
      const hourStr = `${hour}h00min`;

      const collectedLogs = [];
      const tempFilesToCleanup = []; // Liste des fichiers temporaires à nettoyer

      // Calculer le timestamp de 2 minutes en arrière
      const twoMinutesAgo = Math.floor(Date.now() / 1000) - 120; // 2 minutes en secondes

      // Parcourir tous les containers Docker
      const containerDirs = readdirSync(this.docker_log_dir, {
        withFileTypes: true,
      });

      for (const containerDir of containerDirs) {
        if (!containerDir.isDirectory()) continue;

        const containerId = containerDir.name;
        const containerPath = join(this.docker_log_dir, containerId);

        // Obtenir le nom du container depuis Docker
        let containerName = containerId;
        try {
          const { stdout } = await execAsync(
            `docker inspect --format "{{.Name}}" ${containerId}`,
            { timeout: 30000 },
          );
          if (stdout && stdout.trim()) {
            containerName = stdout.trim().replace(/^\//, "");
          }
        } catch (error) {
          // Utiliser l'ID si on ne peut pas obtenir le nom
          containerName = containerId;
        }

        // Créer le répertoire pour ce container
        const containerLogDir = join(this.log_base_dir, containerName, dateStr);
        if (!existsSync(containerLogDir)) {
          mkdirSync(containerLogDir, { recursive: true });
        }

        // Chercher les fichiers de logs JSON
        const logFiles = readdirSync(containerPath).filter((file) =>
          file.endsWith("-json.log"),
        );

        for (const logFileName of logFiles) {
          try {
            const logFilePath = join(containerPath, logFileName);

            // Créer une copie temporaire du fichier de log
            const tempLogFile = join(
              containerLogDir,
              `${containerId}_${logFileName}_temp`,
            );
            copyFileSync(logFilePath, tempLogFile);
            tempFilesToCleanup.push(tempLogFile);

            // Lire le contenu du fichier temporaire
            let logLines = [];
            try {
              const content = readFileSync(tempLogFile, "utf-8");
              logLines = content.split("\n").filter((line) => line.trim());
            } catch (error) {
              // Essayer avec un encodage différent si UTF-8 échoue
              try {
                const content = readFileSync(tempLogFile, "latin1");
                logLines = content.split("\n").filter((line) => line.trim());
              } catch (err) {
                logger.error(
                  `Erreur lors de la lecture du log ${logFilePath}: ${err.message}`,
                );
                continue;
              }
            }

            if (logLines.length > 0) {
              // Séparer les logs stdout et stderr des 2 dernières minutes
              const newAllLogs = [];
              const newErrorLogs = [];

              let keptLines = 0;

              for (const line of logLines) {
                try {
                  // Parser la ligne JSON Docker
                  const logEntry = JSON.parse(line.trim());

                  // Vérifier si le log date de moins de 2 minutes
                  const logTimestamp = logEntry.time || "";
                  if (logTimestamp) {
                    // Convertir le timestamp en secondes
                    try {
                      // Le timestamp Docker est au format "2024-01-27T10:30:45.123456789Z"
                      const logTime = new Date(logTimestamp);
                      const logTimestampSeconds = Math.floor(
                        logTime.getTime() / 1000,
                      );

                      // Ne garder que les logs des 2 dernières minutes
                      if (logTimestampSeconds >= twoMinutesAgo) {
                        keptLines++;
                        // Ajouter à tous les logs
                        newAllLogs.push(line + "\n");

                        // Ajouter aux erreurs si c'est stderr
                        if (logEntry.stream === "stderr") {
                          newErrorLogs.push(line + "\n");
                        }
                      }
                    } catch (err) {
                      // Si le timestamp est invalide, ignorer cette ligne
                      continue;
                    }
                  } else {
                    // Si pas de timestamp, ignorer cette ligne
                    continue;
                  }
                } catch (err) {
                  // Si ce n'est pas du JSON valide, ignorer cette ligne
                  continue;
                }
              }

              // Fichiers temporaires par heure (ex: 10h00min_all.log)
              const outputFileAll = join(containerLogDir, `${hourStr}_all.log`);
              const outputFileErrors = join(
                containerLogDir,
                `${hourStr}_errors.log`,
              );

              // Ajouter les nouveaux logs aux fichiers temporaires existants (mode append)
              if (newAllLogs.length > 0) {
                appendFileSync(outputFileAll, newAllLogs.join(""), "utf-8");
                if (!collectedLogs.includes(outputFileAll)) {
                  collectedLogs.push(outputFileAll);
                }
                logger.info(
                  `Logs ajoutés au fichier temporaire: ${outputFileAll} (${keptLines} nouvelles lignes des 2 dernières minutes)`,
                );
              }

              if (newErrorLogs.length > 0) {
                appendFileSync(
                  outputFileErrors,
                  newErrorLogs.join(""),
                  "utf-8",
                );
                if (!collectedLogs.includes(outputFileErrors)) {
                  collectedLogs.push(outputFileErrors);
                }
                logger.info(
                  `Erreurs ajoutées au fichier temporaire: ${outputFileErrors} (${newErrorLogs.length} nouvelles lignes d'erreur)`,
                );
              }

              if (newAllLogs.length === 0 && newErrorLogs.length === 0) {
                logger.debug(
                  `Aucun nouveau log des 2 dernières minutes pour le container: ${containerName}`,
                );
              }
            }
          } catch (error) {
            logger.error(
              `Erreur lors de la lecture du log ${logFileName}: ${error.message}`,
            );
          }
        }
      }

      logger.info(
        `Collecte terminée. ${collectedLogs.length} fichiers temporaires mis à jour.`,
      );

      // Stocker la liste des fichiers temporaires à nettoyer
      this.tempFilesToCleanup = tempFilesToCleanup;

      return collectedLogs;
    } catch (error) {
      logger.error(`Erreur lors de la collecte des logs: ${error.message}`);
      return [];
    }
  }

  shouldUpload() {
    /**Détermine si on doit uploader (toutes les heures, au début de chaque heure)*/
    const now = this.getParisTime();
    // Uploader si on est dans les 2 premières minutes de l'heure (pour s'assurer qu'on upload l'heure précédente)
    return now.minute < 2;
  }

  async uploadToS3(logFiles) {
    /**Upload les fichiers de logs vers S3 (seulement toutes les heures)*/
    // Vérifier si on doit uploader
    if (!this.shouldUpload()) {
      logger.info("Pas encore l'heure d'uploader (upload toutes les heures).");
      return;
    }

    // Trouver tous les fichiers temporaires de l'heure précédente
    const now = this.getParisTime();
    // Calculer l'heure précédente
    let prevHour = now.hour;
    let prevDay = now.day;
    let prevMonth = now.month;
    let prevYear = now.year;

    if (prevHour === 0) {
      // Si on est à minuit, l'heure précédente est 23h de la veille
      prevHour = 23;
      // Utiliser Date pour gérer correctement les changements de jour/mois/année
      const currentDate = new Date(prevYear, prevMonth - 1, prevDay);
      currentDate.setDate(currentDate.getDate() - 1);
      prevYear = currentDate.getFullYear();
      prevMonth = currentDate.getMonth() + 1;
      prevDay = currentDate.getDate();
    } else {
      prevHour = prevHour - 1;
    }

    const previousDateStr = `${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(prevDay).padStart(2, "0")}`;
    const previousHourStr = `${String(prevHour).padStart(2, "0")}h00min`;

    // Chercher tous les fichiers temporaires de l'heure précédente
    const filesToUpload = [];
    if (existsSync(this.log_base_dir)) {
      const containerDirs = readdirSync(this.log_base_dir, {
        withFileTypes: true,
      });

      for (const containerDir of containerDirs) {
        if (!containerDir.isDirectory()) continue;

        const dateDir = join(
          this.log_base_dir,
          containerDir.name,
          previousDateStr,
        );
        if (existsSync(dateDir)) {
          // Chercher les fichiers de l'heure précédente
          const allFile = join(dateDir, `${previousHourStr}_all.log`);
          const errorsFile = join(dateDir, `${previousHourStr}_errors.log`);

          if (existsSync(allFile)) {
            filesToUpload.push(allFile);
          }
          if (existsSync(errorsFile)) {
            filesToUpload.push(errorsFile);
          }
        }
      }
    }

    if (filesToUpload.length === 0) {
      logger.info("Aucun fichier de l'heure précédente à uploader.");
      return;
    }

    try {
      let uploadedCount = 0;

      for (const logFile of filesToUpload) {
        if (!existsSync(logFile)) {
          logger.warn(`Fichier non trouvé: ${logFile}`);
          continue;
        }

        // Créer le chemin S3 avec extension .log.gz
        const relativePath = logFile.replace(this.log_base_dir + "/", "");
        const s3Key = `${this.env}/${relativePath}.gz`;

        // Compresser le fichier
        const compressedFile = logFile + ".gz";
        await pipeline(
          createReadStream(logFile),
          createGzip(),
          createWriteStream(compressedFile),
        );

        // Upload vers S3
        try {
          const fileContent = readFileSync(compressedFile);
          await this.s3Client.send(
            new PutObjectCommand({
              Bucket: this.aws_logs_bucket,
              Key: s3Key,
              Body: fileContent,
            }),
          );
          logger.info(`Upload réussi: s3://${this.aws_logs_bucket}/${s3Key}`);
          uploadedCount++;

          // Supprimer les fichiers locaux après upload réussi
          unlinkSync(logFile);
          unlinkSync(compressedFile);
        } catch (error) {
          logger.error(
            `Erreur lors de l'upload de ${logFile}: ${error.message}`,
          );
          // Nettoyer le fichier compressé temporaire
          if (existsSync(compressedFile)) {
            unlinkSync(compressedFile);
          }
        }
      }

      logger.info(
        `Upload terminé. ${uploadedCount} fichiers uploadés vers S3.`,
      );

      // Nettoyer les fichiers temporaires après upload réussi
      if (uploadedCount > 0) {
        await this.cleanupTempFiles();
        await this.cleanupTempLogs();
      }
    } catch (error) {
      logger.error(`Erreur lors de l'upload vers S3: ${error.message}`);
    }
  }

  async cleanupOldLogs() {
    /**Nettoie les anciens logs locaux (plus de 7 jours)*/
    try {
      const currentTime = Math.floor(Date.now() / 1000);
      const maxAge = 7 * 24 * 3600; // 7 jours en secondes

      const cleanupRecursive = (dir) => {
        if (!existsSync(dir)) return;

        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            cleanupRecursive(fullPath);
          } else if (
            (entry.name.endsWith("_all.log") ||
              entry.name.endsWith("_errors.log")) &&
            !entry.name.endsWith(".gz")
          ) {
            const stats = statSync(fullPath);
            if (
              currentTime - Math.floor(stats.mtime.getTime() / 1000) >
              maxAge
            ) {
              unlinkSync(fullPath);
              logger.info(`Ancien log supprimé: ${fullPath}`);
            }
          }
        }
      };

      cleanupRecursive(this.log_base_dir);
    } catch (error) {
      logger.error(`Erreur lors du nettoyage: ${error.message}`);
    }
  }

  async cleanupTempLogs() {
    /**Nettoie les fichiers temporaires de l'heure précédente après upload réussi*/
    try {
      const now = this.getParisTime();
      // Calculer l'heure précédente
      let prevHour = now.hour;
      let prevDay = now.day;
      let prevMonth = now.month;
      let prevYear = now.year;

      if (prevHour === 0) {
        // Si on est à minuit, l'heure précédente est 23h de la veille
        prevHour = 23;
        // Utiliser Date pour gérer correctement les changements de jour/mois/année
        const currentDate = new Date(prevYear, prevMonth - 1, prevDay);
        currentDate.setDate(currentDate.getDate() - 1);
        prevYear = currentDate.getFullYear();
        prevMonth = currentDate.getMonth() + 1;
        prevDay = currentDate.getDate();
      } else {
        prevHour = prevHour - 1;
      }

      const previousDateStr = `${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(prevDay).padStart(2, "0")}`;
      const previousHourStr = `${String(prevHour).padStart(2, "0")}h00min`;

      // Supprimer les fichiers temporaires de l'heure précédente
      if (existsSync(this.log_base_dir)) {
        const containerDirs = readdirSync(this.log_base_dir, {
          withFileTypes: true,
        });

        for (const containerDir of containerDirs) {
          if (!containerDir.isDirectory()) continue;

          const dateDir = join(
            this.log_base_dir,
            containerDir.name,
            previousDateStr,
          );
          if (existsSync(dateDir)) {
            const allFile = join(dateDir, `${previousHourStr}_all.log`);
            const errorsFile = join(dateDir, `${previousHourStr}_errors.log`);

            if (existsSync(allFile)) {
              unlinkSync(allFile);
              logger.info(`Fichier temporaire supprimé: ${allFile}`);
            }
            if (existsSync(errorsFile)) {
              unlinkSync(errorsFile);
              logger.info(`Fichier temporaire supprimé: ${errorsFile}`);
            }
          }
        }
      }
    } catch (error) {
      logger.error(
        `Erreur lors du nettoyage des fichiers temporaires: ${error.message}`,
      );
    }
  }

  async cleanupTempFiles() {
    /**Nettoie les fichiers temporaires créés lors de la collecte*/
    if (!this.tempFilesToCleanup) {
      return;
    }

    try {
      let cleanedCount = 0;
      for (const tempFilePath of this.tempFilesToCleanup) {
        try {
          if (existsSync(tempFilePath)) {
            unlinkSync(tempFilePath);
            cleanedCount++;
            logger.info(`Fichier temporaire supprimé: ${tempFilePath}`);
          }
        } catch (error) {
          logger.error(
            `Erreur lors de la suppression du fichier temporaire ${tempFilePath}: ${error.message}`,
          );
        }
      }

      logger.info(
        `Nettoyage terminé. ${cleanedCount} fichiers temporaires supprimés.`,
      );

      // Vider la liste après traitement
      this.tempFilesToCleanup = [];
    } catch (error) {
      logger.error(
        `Erreur lors du nettoyage des fichiers temporaires: ${error.message}`,
      );
    }
  }
}

async function main() {
  /**Point d'entrée principal*/
  const args = process.argv.slice(2);
  let env = "sandbox";

  // Parser les arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" && args[i + 1]) {
      env = args[i + 1];
      break;
    }
  }

  const service = new DockerLogCollectorService(env);

  // Exécution unique (pour cron)
  const logFiles = await service.collectDockerLogs();
  await service.uploadToS3(logFiles);
  await service.cleanupOldLogs();
}

// Exécuter si appelé directement
// Le script est toujours exécuté directement via node, donc on exécute main()
main().catch((error) => {
  logger.error(`Erreur fatale: ${error.message}`);
  process.exit(1);
});

export { DockerLogCollectorService };
