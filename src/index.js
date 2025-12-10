/**
 * Point d'entrée principal de l'agent.
 *
 * Responsabilités :
 * - Charger la configuration et la consigner dans les logs.
 * - Initialiser la connexion Docker.
 * - Démarrer le serveur WebSocket frontend.
 * - Gérer l'arrêt propre (SIGINT/SIGTERM) et les erreurs globales.
 *
 * @module index
 */

import { loadConfig } from "./config/env.js";
import { logger } from "./shared/logger.js";
import { createFrontendServer } from "./websocket/server.js";
import { initDocker } from "./modules/docker/manager.js";
import { getNetworkInfo } from "./modules/metadata/actions/utils.js";
import { closeRedisConnection } from "./shared/redis.js";
import { startLogCollector, stopLogCollector } from "./modules/haproxy/logCollector.js";
import {
  startActivityCollector,
  stopActivityCollector,
} from "./modules/activity/activityCollector.js";

/**
 * Fonction principale orchestrant le cycle de vie de l'agent.
 */
async function main() {
  try {
    // 1. Charger la configuration validée.
    const config = loadConfig();

    // 2. Récupérer l'IP du serveur pour la vérification des tokens
    const serverIp = await getNetworkInfo();
    if (!serverIp) {
      logger.warn(
        "Impossible de récupérer l'IP du serveur, la vérification des tokens pourrait échouer"
      );
    }

    logger.info("Démarrage de l'agent ", {
      hostname: config.hostname,
      serverIp: serverIp || "non disponible",
    });

    // 3. Initialiser Docker une fois pour toutes (lazy singleton).
    initDocker(config.dockerSocketPath);

    // 4. Démarrer le collecteur de logs HAProxy en arrière-plan
    try {
      await startLogCollector();
    } catch (error) {
      logger.warn("Impossible de démarrer le collecteur de logs HAProxy", {
        error: error.message,
      });
      // Continuer même si le collecteur ne démarre pas
    }

    // 5. Démarrer le collecteur d'événements d'activité en arrière-plan
    try {
      await startActivityCollector();
    } catch (error) {
      logger.warn(
        "Impossible de démarrer le collecteur d'événements d'activité",
        {
          error: error.message,
        }
      );
      // Continuer même si le collecteur ne démarre pas
    }

    // 6. Démarrer le serveur WebSocket pour les connexions frontend.
    // Note: createFrontendServer est maintenant async car il récupère le hostname via nsenter
    const frontendServer = await createFrontendServer({
      port: config.frontendPort,
      host: config.frontendHost,
      serverIp: serverIp || null,
      healthcheckPath: config.healthcheckPath,
    });

    let isShuttingDown = false;

    const gracefulShutdown = async (signal) => {
      if (isShuttingDown) {
        return;
      }
      isShuttingDown = true;

      logger.info(`Signal ${signal} reçu, arrêt en cours...`);

      // Arrêter le collecteur de logs HAProxy
      try {
        await stopLogCollector();
      } catch (error) {
        logger.error("Erreur lors de l'arrêt du collecteur de logs", {
          error: error.message,
        });
      }

      // Arrêter le collecteur d'événements d'activité
      try {
        await stopActivityCollector();
      } catch (error) {
        logger.error("Erreur lors de l'arrêt du collecteur d'activité", {
          error: error.message,
        });
      }

      try {
        await frontendServer.close();
      } catch (error) {
        logger.error("Erreur lors de la fermeture du serveur frontend", {
          error: error.message,
        });
      }

      // Fermer la connexion Redis proprement
      try {
        await closeRedisConnection();
      } catch (error) {
        logger.error("Erreur lors de la fermeture de Redis", {
          error: error.message,
        });
      }
    };

    // 4. Gestion des signaux d'arrêt.
    process.on("SIGTERM", () => {
      gracefulShutdown("SIGTERM")
        .then(() => process.exit(0))
        .catch((error) => {
          logger.error("Erreur lors de l'arrêt suite à SIGTERM", {
            error: error.message,
          });
          process.exit(1);
        });
    });
    process.on("SIGINT", () => {
      gracefulShutdown("SIGINT")
        .then(() => process.exit(0))
        .catch((error) => {
          logger.error("Erreur lors de l'arrêt suite à SIGINT", {
            error: error.message,
          });
          process.exit(1);
        });
    });

    // 5. Dernier filet de sécurité (exceptions/rejets).
    process.on("uncaughtException", (error) => {
      logger.error("Exception non capturée", { error: error.message });
      gracefulShutdown("uncaughtException").finally(() => process.exit(1));
    });

    process.on("unhandledRejection", (reason, promise) => {
      logger.error("Rejet non géré", {
        reason: reason?.message || reason,
        promise,
      });
    });
  } catch (error) {
    logger.error("Erreur fatale lors du démarrage", {
      error: error.message,
    });
    process.exit(1);
  }
}

// Lancer l'agent immédiatement.
main();

