/**
 * Types/utilitaires pour les messages WebSocket frontend ↔ agent.
 *
 * Tout message qui circule transite par ces helpers afin de garantir
 * un format homogène et facilement sérialisable. Cela simplifie l'ajout de
 * nouveaux types (streams, erreurs, etc.) et centralise la documentation.
 *
 * @module types/messages
 */

/**
 * Message envoyé par le frontend vers l'agent
 * @typedef {Object} BackendMessage
 * @property {string} id - ID unique de la requête
 * @property {string} action - Action à exécuter (ex: "docker.list")
 * @property {Object} [params] - Paramètres de l'action
 */

/**
 * Message de réponse envoyé par l'agent vers le frontend
 * @typedef {Object} AgentResponse
 * @property {string} type - Type de message ("response" | "stream" | "error")
 * @property {string} id - ID de la requête originale
 * @property {boolean} [success] - Succès de l'opération
 * @property {*} [data] - Données de réponse
 * @property {string} [error] - Message d'erreur
 * @property {string} [stream] - Type de stream ("stdout" | "stderr")
 */

/**
 * Crée un message de réponse
 * @param {string} id - ID de la requête
 * @param {boolean} success - Succès
 * @param {*} data - Données
 * @param {string} [error] - Erreur
 * @returns {AgentResponse} Message formaté
 */
export function createResponse(id, success, data = null, error = null) {
  return {
    type: "response",
    id,
    success,
    ...(data !== null && { data }),
    ...(error && { error }),
  };
}

/**
 * Crée un message de stream
 * @param {string} id - ID de la requête
 * @param {string} streamType - Type de stream ("stdout" | "stderr")
 * @param {string} data - Données du stream
 * @returns {AgentResponse} Message formaté
 */
export function createStream(id, streamType, data) {
  return {
    type: "stream",
    id,
    stream: streamType,
    data,
  };
}

/**
 * Crée un message d'erreur
 * @param {string} id - ID de la requête
 * @param {string} error - Message d'erreur
 * @returns {AgentResponse} Message formaté
 */
export function createError(id, error) {
  return {
    type: "error",
    id,
    success: false,
    error,
  };
}

