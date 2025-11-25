/**
 * Gestionnaires de messages WebSocket pour l'agent 
 * @module websocket/handlers
 */

import {
  listContainers,
  inspectContainer,
  startContainer,
  stopContainer,
  restartContainer,
  getContainerLogs,
  getContainerStats,
  execContainer,
} from "../modules/docker/actions.js";
import { createResponse, createStream, createError } from "../types/messages.js";
import { logger } from "../utils/logger.js";
import { isValidDockerAction } from "../utils/validator.js";

/**
 * Traite un message reçu du frontend
 * @param {Object} message - Message reçu
 * @param {Function} sendMessage - Fonction pour envoyer une réponse
 * @param {Function} [registerResource] - Callback pour enregistrer une ressource (ex: stream) associée à l'ID
 * @returns {Promise<void>}
 */
export async function handleMessage(
  message,
  sendMessage,
  registerResource = () => {}
) {
  const { id, action, params = {} } = message;

  if (!id) {
    logger.warn("Message reçu sans ID", { message });
    return;
  }

  try {
    let isStreamingAction = false;

    // Parser l'action (format: "docker.list", "docker.start", etc.)
    const [module, actionName] = action.split(".");

    if (module !== "docker") {
      sendMessage(
        createError(id, `Module non supporté: ${module}`)
      );
      return;
    }

    if (!isValidDockerAction(actionName)) {
      sendMessage(
        createError(id, `Action Docker non autorisée: ${actionName}`)
      );
      return;
    }

    logger.debug("Traitement de l'action", { id, action, params });

    // Router vers la bonne action Docker
    let result;

    switch (actionName) {
      case "list":
        result = await listContainers(params);
        break;

      case "inspect":
        result = await inspectContainer(params);
        break;

      case "start":
        result = await startContainer(params);
        break;

      case "stop":
        result = await stopContainer(params);
        break;

      case "restart":
        result = await restartContainer(params);
        break;

      case "logs": {
        const { follow } = params;
        if (follow) {
          // Mode streaming
          const logsResult = await getContainerLogs(
            params,
            (data) => {
              sendMessage(createStream(id, "stdout", data));
            }
          );
          registerResource(id, {
            type: "docker-logs",
            cleanup: () => {
              if (logsResult?.stream?.destroy) {
                logsResult.stream.destroy();
              } else if (logsResult?.stream?.end) {
                logsResult.stream.end();
              }
            },
          });
          isStreamingAction = true;
          sendMessage(
            createResponse(id, true, {
              stream: "stdout",
              mode: "logs.follow",
            })
          );
          return;
        } else {
          // Mode one-shot
          result = await getContainerLogs(params);
          result = result.logs;
        }
        break;
      }

      case "stats": {
        const { stream } = params;
        if (stream) {
          // Mode streaming
          const statsResult = await getContainerStats(
            params,
            (stats) => {
              sendMessage(createStream(id, "stdout", JSON.stringify(stats)));
            }
          );
          registerResource(id, {
            type: "docker-stats",
            cleanup: () => {
              if (statsResult?.stats?.destroy) {
                statsResult.stats.destroy();
              } else if (statsResult?.stats?.end) {
                statsResult.stats.end();
              }
            },
          });
          isStreamingAction = true;
          sendMessage(
            createResponse(id, true, {
              stream: "stdout",
              mode: "stats.stream",
            })
          );
          return;
        } else {
          // Mode one-shot
          result = await getContainerStats(params);
        }
        break;
      }

      case "exec":
        result = await execContainer(params);
        break;

      default:
        throw new Error(`Action non implémentée: ${actionName}`);
    }

    // Envoyer la réponse
    if (!isStreamingAction) {
      registerResource(id, null);
      sendMessage(createResponse(id, true, result));
    }
  } catch (error) {
    logger.error("Erreur lors du traitement du message", {
      id,
      action,
      error: error.message,
    });
    registerResource(id, null);
    sendMessage(createError(id, error.message));
  }
}

