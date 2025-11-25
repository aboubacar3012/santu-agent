/**
 * Point d'entrée principal de l'agent 
 * @module index
 */

import { loadConfig } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { createFrontendServer } from "./websocket/server.js";
import { initDocker } from "./modules/docker/manager.js";

/**
 * Fonction principale
 */
async function main() {
  try {
    // Charger la configuration
    const config = loadConfig();
    logger.info("Démarrage de l'agent ", {
      hostname: config.hostname,
    });

    // Initialiser Docker
    initDocker(config.dockerSocketPath);

    // Démarrer le serveur WebSocket pour les connexions frontend
    const frontendServer = createFrontendServer({
      port: config.frontendPort,
      host: config.frontendHost,
      token: config.clientToken,
    });

    let isShuttingDown = false;

    const gracefulShutdown = async (signal) => {
      if (isShuttingDown) {
        return;
      }
      isShuttingDown = true;

      logger.info(`Signal ${signal} reçu, arrêt en cours...`);

      try {
        await frontendServer.close();
      } catch (error) {
        logger.error("Erreur lors de la fermeture du serveur frontend", {
          error: error.message,
        });
      }
    };

    // Gérer l'arrêt propre
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

    // Gérer les erreurs non capturées
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

// Démarrer l'agent
main();

