import http from "http";
import { WebSocketServer } from "ws";
import { logger } from "../utils/logger.js";
import { handleMessage } from "./handlers.js";
import { createError } from "../types/messages.js";


const DEFAULT_HEALTHCHECK_PATH = "/healthcheck";

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
export function createFrontendServer({
  port,
  host,
  token,
  hostname,
  healthcheckPath = DEFAULT_HEALTHCHECK_PATH,
}) {
  const normalizedHealthcheckPath = normalizeHealthcheckPath(healthcheckPath);
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    perMessageDeflate: false,
  });

  server.on("request", (req, res) => {
    handleHttpRequest(req, res, normalizedHealthcheckPath);
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
      logger.warn("Tentative de connexion avec un token invalide ", {
        remoteAddress: req.socket.remoteAddress,
        requestedServerHostname,
      });
      ws.close(1008, "Invalid token");
      return;
    }

    if (!requestedServerHostname && requestedServerHostname !== hostname) {
      logger.warn("Tentative de connexion sans hostname spécifié", {
        remoteAddress: req.socket.remoteAddress,
      });
      ws.close(1008, "Hostname requis");
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
      healthcheckPath: normalizedHealthcheckPath,
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

function normalizeHealthcheckPath(pathname) {
  if (!pathname) {
    return DEFAULT_HEALTHCHECK_PATH;
  }

  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function handleHttpRequest(req, res, healthcheckPath) {
  // Laisser les requêtes d'upgrade WebSocket être gérées par ws.
  if (req.headers.upgrade) {
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`
    );
  } catch (error) {
    logger.warn("Requête HTTP invalide reçue sur le serveur frontend", {
      error: error.message,
    });
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "error", message: "Invalid URL" }));
    return;
  }

  if (requestUrl.pathname !== healthcheckPath) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "error", message: "Not Found" }));
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, {
      "Content-Type": "application/json",
      Allow: "GET, HEAD",
    });
    res.end(JSON.stringify({ status: "error", message: "Method Not Allowed" }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  res.end(
    JSON.stringify({
      status: "ok",
      uptime: Number(process.uptime().toFixed(3)),
      timestamp: new Date().toISOString(),
    })
  );
}

