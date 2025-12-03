/**
 * Gestionnaires de messages WebSocket.
 *
 * `handleMessage` agit comme routeur central générique :
 * 1. Valide le format du message (présence d'ID/action).
 * 2. Parse l'action au format "module.action" et charge le module correspondant.
 * 3. Vérifie que l'action est autorisée via le validator du module.
 * 4. Exécute l'action correspondante dans le module.
 * 5. Enregistre/relâche les ressources longues (streams logs/stats).
 *
 * @module websocket/handlers
 */

import {
  createResponse,
  createStream,
  createError,
} from "../shared/messages.js";
import { logger } from "../shared/logger.js";
import { getModule } from "../modules/index.js";

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

    // Parser l'action (format: "docker.list", "ssh.add", etc.)
    const [moduleName, actionName] = action.split(".");

    if (!moduleName || !actionName) {
      sendMessage(
        createError(id, `Format d'action invalide. Attendu: "module.action"`)
      );
      return;
    }

    // Charger le module
    const module = getModule(moduleName);
    if (!module) {
      sendMessage(createError(id, `Module non supporté: ${moduleName}`));
      return;
    }

    // Vérifier que l'action est autorisée via le validator du module
    const { validator, actions } = module;
    if (
      !validator.isValidAction ||
      typeof validator.isValidAction !== "function"
    ) {
      sendMessage(
        createError(id, `Module ${moduleName} n'expose pas de validator valide`)
      );
      return;
    }

    if (!validator.isValidAction(actionName)) {
      sendMessage(
        createError(
          id,
          `Action ${actionName} non autorisée pour le module ${moduleName}`
        )
      );
      return;
    }

    logger.debug("Traitement de l'action", { id, action, params });

    // Valider les paramètres via le validator du module
    let validatedParams = params;
    if (
      validator.validateParams &&
      typeof validator.validateParams === "function"
    ) {
      validatedParams = validator.validateParams(actionName, params);
    }

    // Exécuter l'action
    const actionFunction = actions[actionName];
    if (!actionFunction || typeof actionFunction !== "function") {
      sendMessage(
        createError(
          id,
          `Action ${actionName} non implémentée dans le module ${moduleName}`
        )
      );
      return;
    }

    // Gérer les actions avec streaming
    const result = await actionFunction(validatedParams, {
      onStream: (streamType, data) => {
        sendMessage(createStream(id, streamType, data));
      },
      onResource: (resource) => {
        registerResource(id, resource);
      },
    });

    // Si l'action retourne un objet avec des informations de streaming
    if (result && typeof result === "object") {
      if (result.isStreaming) {
        isStreamingAction = true;
        if (result.resource) {
          registerResource(id, result.resource);
        }
        if (result.initialResponse) {
          sendMessage(createResponse(id, true, result.initialResponse));
        }
        return;
      }
    }

    // Envoyer la réponse pour les actions non-streaming
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

