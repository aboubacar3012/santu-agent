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
import { logger } from "./utils/logger.js";
import { createFrontendServer } from "./websocket/server.js";
import { initDocker } from "./modules/docker/manager.js";

/**
 * Fonction principale orchestrant le cycle de vie de l'agent.
 */
async function main() {
  try {
    // 1. Charger la configuration validée.
    const config = loadConfig();
    logger.info("Démarrage de l'agent ", {
      hostname: config.hostname,
    });

    // 2. Initialiser Docker une fois pour toutes (lazy singleton).
    initDocker(config.dockerSocketPath);

    // 3. Démarrer le serveur WebSocket pour les connexions frontend.
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

