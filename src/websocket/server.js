import http from "http";
import { WebSocketServer } from "ws";
import { logger } from "../utils/logger.js";
import { handleMessage } from "./handlers.js";
import { createError } from "../types/messages.js";

/**
 * Serveur WebSocket frontend.
 *
 * Ce module encapsule la création du serveur HTTP + WebSocket et gère :
 * - l'authentification via query string (token),
 * - l'isolation des connexions (cleanup des streams par client),
 * - la délégation des messages à `handleMessage`,
 * - l'arrêt propre (terminaison des clients, fermeture du serveur HTTP).
 *
 * @param {Object} options - Options de configuration
 * @param {number} options.port - Port d'écoute
 * @param {string} options.host - Interface réseau d'écoute
 * @param {string|null} options.token - Jeton requis pour l'authentification
 * @returns {{ server: import('http').Server, wss: WebSocketServer, close: () => Promise<void> }}
 */
export function createFrontendServer({ port, host, token }) {
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    perMessageDeflate: false,
  });

  wss.on("connection", (ws, req) => {
    let connectionUrl;

    try {
      connectionUrl = new URL(req.url || "/", `http://${req.headers.host}`);
    } catch (error) {
      logger.warn("URL de connexion WebSocket invalide", {
        error: error.message,
        remoteAddress: req.socket.remoteAddress,
      });
      ws.close(1008, "Invalid connection URL");
      return;
    }

    const clientToken = connectionUrl.searchParams.get("token");
    const requestedServerHostname =
      connectionUrl.searchParams.get("hostname") || null;

    if (token && clientToken !== token) {
      logger.warn("Tentative de connexion avec un token invalide", {
        remoteAddress: req.socket.remoteAddress,
        requestedServerHostname,
      });
      ws.close(1008, "Invalid token");
      return;
    }

    const remoteAddress = req.socket.remoteAddress;

    logger.info("Client frontend connecté", {
      remoteAddress,
      requestedServerHostname,
    });

    const activeResources = new Map();

    const registerResource = (requestId, resource) => {
      if (!requestId) {
        return;
      }

      const existing = activeResources.get(requestId);
      if (existing?.cleanup) {
        try {
          existing.cleanup();
        } catch (error) {
          logger.warn("Erreur lors du nettoyage d'une ressource active", {
            error: error.message,
            requestId,
          });
        }
      }

      if (resource) {
        activeResources.set(requestId, resource);
      } else {
        activeResources.delete(requestId);
      }
    };

    const cleanupResources = () => {
      activeResources.forEach((resource, requestId) => {
        if (resource?.cleanup) {
          try {
            resource.cleanup();
          } catch (error) {
            logger.warn(
              "Erreur lors du nettoyage d'une ressource à la fermeture",
              {
                error: error.message,
                requestId,
              }
            );
          }
        }
      });
      activeResources.clear();
    };

    ws.on("message", async (rawData) => {
      let message;

      try {
        message = JSON.parse(rawData.toString());
      } catch (error) {
        logger.warn("Payload JSON invalide reçu du frontend", {
          error: error.message,
          remoteAddress,
        });
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify(createError("unknown", "Payload JSON invalide"))
          );
        }
        return;
      }

      if (!message?.id) {
        logger.warn("Message reçu sans identifiant", {
          remoteAddress,
        });
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify(
              createError("unknown", "Identifiant de requête manquant")
            )
          );
        }
        return;
      }

      try {
        await handleMessage(
          message,
          (response) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(response));
            }
          },
          (requestId, resource) => {
            registerResource(requestId, resource);
          }
        );
      } catch (error) {
        logger.error("Erreur lors du traitement d'une requête frontend", {
          error: error.message,
          remoteAddress,
        });
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify(
              createError(message.id, error.message || "Erreur interne")
            )
          );
        }
      }
    });

    ws.on("close", () => {
      cleanupResources();
      logger.info("Client frontend déconnecté", {
        remoteAddress,
        requestedServerHostname,
      });
    });

    ws.on("error", (error) => {
      logger.error("Erreur WebSocket côté frontend", {
        error: error.message,
        remoteAddress,
        requestedServerHostname,
      });
      cleanupResources();
    });
  });

  server.listen(port, host, () => {
    logger.info("Serveur WebSocket frontend démarré", {
      port,
      host,
    });
  });

  return {
    server,
    wss,
    close: () =>
      new Promise((resolve, reject) => {
        wss.clients.forEach((client) => {
          try {
            client.terminate();
          } catch (error) {
            logger.warn("Erreur lors de la terminaison d'un client", {
              error: error.message,
            });
          }
        });

        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

