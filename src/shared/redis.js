/**
 * Module Redis réutilisable pour le cache
 *
 * Ce module fournit des fonctions réutilisables pour interagir avec Redis.
 * Il gère automatiquement la connexion, la reconnexion et les erreurs.
 *
 * @module shared/redis
 */

import { createClient } from "redis";
import { logger } from "./logger.js";

let redisClient = null;
let isConnecting = false;
let connectionPromise = null;

/**
 * Obtient ou crée le client Redis
 * @returns {Promise<import('redis').RedisClientType|null>} Client Redis ou null si Redis n'est pas configuré
 */
async function getRedisClient() {
  // Si Redis n'est pas configuré, retourner null
  const redisHost = process.env.REDIS_HOST;
  if (!redisHost) {
    return null;
  }

  // Si le client existe déjà et est connecté, le retourner
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  // Si une connexion est en cours, attendre qu'elle se termine
  if (isConnecting && connectionPromise) {
    return await connectionPromise;
  }

  // Créer une nouvelle connexion
  isConnecting = true;
  connectionPromise = (async () => {
    try {
      const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);
      const redisPassword = process.env.REDIS_PASSWORD || undefined;

      const client = createClient({
        socket: {
          host: redisHost,
          port: redisPort,
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              logger.error("Trop de tentatives de reconnexion Redis, abandon");
              return false; // Arrêter de réessayer
            }
            const delay = Math.min(retries * 100, 3000);
            logger.debug(`Tentative de reconnexion Redis dans ${delay}ms`, {
              retries,
            });
            return delay;
          },
        },
        ...(redisPassword && { password: redisPassword }),
      });

      // Gérer les erreurs de connexion
      client.on("error", (err) => {
        logger.warn("Erreur Redis", { error: err.message });
      });

      client.on("connect", () => {
        logger.debug("Connexion Redis établie", {
          host: redisHost,
          port: redisPort,
        });
      });

      client.on("reconnecting", () => {
        logger.debug("Reconnexion Redis en cours...");
      });

      // Connecter le client
      await client.connect();

      redisClient = client;
      isConnecting = false;
      connectionPromise = null;

      return client;
    } catch (error) {
      isConnecting = false;
      connectionPromise = null;
      logger.error("Erreur lors de la connexion à Redis", {
        error: error.message,
        host: redisHost,
      });
      return null;
    }
  })();

  return await connectionPromise;
}

/**
 * Stocke un log dans Redis avec un TTL de 24h
 * @param {string} key - Clé Redis (ex: "haproxy:logs:2025-12-10")
 * @param {string} logLine - Ligne de log à stocker
 * @param {number} ttlSeconds - TTL en secondes (défaut: 24h = 86400)
 * @param {number} maxLogs - Nombre maximum de logs à garder par jour (défaut: 10000)
 * @returns {Promise<boolean>} True si stocké avec succès, false sinon
 */
export async function storeLog(
  key,
  logLine,
  ttlSeconds = 86400,
  maxLogs = 10000
) {
  try {
    const client = await getRedisClient();
    if (!client) {
      return false; // Redis non disponible, continuer sans cache
    }

    // Utiliser une liste Redis pour stocker les logs (LPUSH pour ajouter au début)
    // Chaque élément de la liste est un JSON avec timestamp et logLine
    const logEntry = JSON.stringify({
      timestamp: Date.now(),
      log: logLine,
    });

    // Ajouter le log au début de la liste
    await client.lPush(key, logEntry);

    // Limiter la taille de la liste pour éviter qu'elle ne devienne trop grande
    // On garde les N derniers logs (les plus récents sont au début avec lPush)
    if (maxLogs > 0) {
      await client.lTrim(key, 0, maxLogs - 1);
    }

    // Définir le TTL sur la clé
    await client.expire(key, ttlSeconds);

    return true;
  } catch (error) {
    logger.warn("Erreur lors du stockage du log dans Redis", {
      error: error.message,
      key,
    });
    return false;
  }
}

/**
 * Récupère les logs en cache depuis Redis
 * @param {string} key - Clé Redis (ex: "haproxy:logs:2025-12-10")
 * @param {number} limit - Nombre maximum de logs à récupérer (défaut: 10000)
 * @returns {Promise<Array<{timestamp: number, log: string}>>} Liste des logs en cache (du plus ancien au plus récent)
 */
export async function getCachedLogs(key, limit = 10000) {
  try {
    const client = await getRedisClient();
    if (!client) {
      return []; // Redis non disponible, retourner un tableau vide
    }

    // Récupérer la longueur de la liste
    const listLength = await client.lLen(key);
    if (listLength === 0) {
      return [];
    }

    // Avec lPush, les plus récents sont au début (index 0)
    // Pour avoir du plus ancien au plus récent, on récupère les N derniers éléments
    // et on les inverse
    const startIndex = Math.max(0, listLength - limit);
    const logs = await client.lRange(key, startIndex, -1);

    // Inverser l'ordre car lPush ajoute au début, donc les plus anciens sont à la fin
    logs.reverse();

    // Parser chaque entrée JSON
    const parsedLogs = logs
      .map((entry) => {
        try {
          return JSON.parse(entry);
        } catch (error) {
          logger.debug("Erreur lors du parsing d'un log en cache", {
            error: error.message,
          });
          return null;
        }
      })
      .filter((entry) => entry !== null);

    return parsedLogs;
  } catch (error) {
    logger.warn("Erreur lors de la récupération des logs en cache", {
      error: error.message,
      key,
    });
    return [];
  }
}

/**
 * Récupère les logs en cache des dernières 24h depuis Redis
 * @param {string} prefix - Préfixe de la clé (ex: "haproxy:logs")
 * @param {number} limitPerDay - Nombre maximum de logs par jour (défaut: 10000)
 * @returns {Promise<Array<{timestamp: number, log: string}>>} Liste des logs en cache (du plus ancien au plus récent)
 */
export async function getCachedLogsLast24h(prefix, limitPerDay = 10000) {
  try {
    const client = await getRedisClient();
    if (!client) {
      return [];
    }

    // Générer les clés pour aujourd'hui et hier
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const todayKey = generateLogKey(prefix, today);
    const yesterdayKey = generateLogKey(prefix, yesterday);

    // Récupérer les logs d'hier et d'aujourd'hui
    const [yesterdayLogs, todayLogs] = await Promise.all([
      getCachedLogs(yesterdayKey, limitPerDay),
      getCachedLogs(todayKey, limitPerDay),
    ]);

    // Filtrer les logs d'hier pour ne garder que ceux des dernières 24h
    const now = Date.now();
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
    const filteredYesterdayLogs = yesterdayLogs.filter(
      (log) => log.timestamp >= twentyFourHoursAgo
    );

    // Combiner et trier par timestamp (du plus ancien au plus récent)
    const allLogs = [...filteredYesterdayLogs, ...todayLogs].sort(
      (a, b) => a.timestamp - b.timestamp
    );

    return allLogs;
  } catch (error) {
    logger.warn("Erreur lors de la récupération des logs des dernières 24h", {
      error: error.message,
      prefix,
    });
    return [];
  }
}

/**
 * Génère une clé Redis pour les logs HAProxy basée sur la date
 * @param {string} prefix - Préfixe de la clé (ex: "haproxy:logs")
 * @param {Date} [date] - Date pour la clé (défaut: aujourd'hui)
 * @returns {string} Clé Redis formatée (ex: "haproxy:logs:2025-12-10")
 */
export function generateLogKey(prefix, date = new Date()) {
  const dateStr = date.toISOString().split("T")[0]; // Format: YYYY-MM-DD
  return `${prefix}:${dateStr}`;
}

/**
 * Génère une clé Redis pour les événements d'activité basée sur la date
 * @param {string} prefix - Préfixe de la clé (ex: "activity:events")
 * @param {Date} [date] - Date pour la clé (défaut: aujourd'hui)
 * @returns {string} Clé Redis formatée (ex: "activity:events:2025-12-10")
 */
export function generateActivityKey(prefix, date = new Date()) {
  const dateStr = date.toISOString().split("T")[0]; // Format: YYYY-MM-DD
  return `${prefix}:${dateStr}`;
}

/**
 * Stocke un événement d'activité dans Redis avec un TTL de 7 jours
 * @param {string} key - Clé Redis (ex: "activity:events:2025-12-10")
 * @param {Object} event - Événement à stocker
 * @param {number} ttlSeconds - TTL en secondes (défaut: 7 jours = 604800)
 * @param {number} maxEvents - Nombre maximum d'événements à garder par jour (défaut: 10000)
 * @returns {Promise<boolean>} True si stocké avec succès, false sinon
 */
export async function storeActivityEvent(
  key,
  event,
  ttlSeconds = 604800, // 7 jours
  maxEvents = 10000
) {
  try {
    const client = await getRedisClient();
    if (!client) {
      return false; // Redis non disponible, continuer sans cache
    }

    // Utiliser une liste Redis pour stocker les événements (LPUSH pour ajouter au début)
    // Chaque élément de la liste est un JSON avec timestamp et event
    const eventEntry = JSON.stringify({
      timestamp: event.timestamp ? new Date(event.timestamp).getTime() : Date.now(),
      event,
    });

    // Ajouter l'événement au début de la liste
    await client.lPush(key, eventEntry);

    // Limiter la taille de la liste pour éviter qu'elle ne devienne trop grande
    // On garde les N derniers événements (les plus récents sont au début avec lPush)
    if (maxEvents > 0) {
      await client.lTrim(key, 0, maxEvents - 1);
    }

    // Définir le TTL sur la clé
    await client.expire(key, ttlSeconds);

    return true;
  } catch (error) {
    logger.warn("Erreur lors du stockage d'un événement d'activité dans Redis", {
      error: error.message,
      key,
    });
    return false;
  }
}

/**
 * Récupère les événements d'activité en cache depuis Redis
 * @param {string} key - Clé Redis (ex: "activity:events:2025-12-10")
 * @param {number} limit - Nombre maximum d'événements à récupérer (défaut: 10000)
 * @returns {Promise<Array<{timestamp: number, event: Object}>>} Liste des événements en cache (du plus ancien au plus récent)
 */
export async function getCachedActivityEvents(key, limit = 10000) {
  try {
    const client = await getRedisClient();
    if (!client) {
      return []; // Redis non disponible, retourner un tableau vide
    }

    // Récupérer la longueur de la liste
    const listLength = await client.lLen(key);
    if (listLength === 0) {
      return [];
    }

    // Avec lPush, les plus récents sont au début (index 0)
    // Pour avoir du plus ancien au plus récent, on récupère les N derniers éléments
    // et on les inverse
    const startIndex = Math.max(0, listLength - limit);
    const events = await client.lRange(key, startIndex, -1);

    // Inverser l'ordre car lPush ajoute au début, donc les plus anciens sont à la fin
    events.reverse();

    // Parser chaque entrée JSON
    const parsedEvents = events
      .map((entry) => {
        try {
          return JSON.parse(entry);
        } catch (error) {
          logger.debug("Erreur lors du parsing d'un événement en cache", {
            error: error.message,
          });
          return null;
        }
      })
      .filter((entry) => entry !== null);

    return parsedEvents;
  } catch (error) {
    logger.warn("Erreur lors de la récupération des événements en cache", {
      error: error.message,
      key,
    });
    return [];
  }
}

/**
 * Récupère les événements d'activité en cache des 7 derniers jours depuis Redis
 * @param {string} prefix - Préfixe de la clé (ex: "activity:events")
 * @param {number} limitPerDay - Nombre maximum d'événements par jour (défaut: 10000)
 * @returns {Promise<Array<{timestamp: number, event: Object}>>} Liste des événements en cache (du plus ancien au plus récent)
 */
export async function getCachedActivityEventsLast7Days(prefix, limitPerDay = 10000) {
  try {
    const client = await getRedisClient();
    if (!client) {
      return [];
    }

    // Générer les clés pour les 7 derniers jours
    const today = new Date();
    const keys = [];
    const eventsPromises = [];

    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const key = generateActivityKey(prefix, date);
      keys.push(key);
      eventsPromises.push(getCachedActivityEvents(key, limitPerDay));
    }

    // Récupérer tous les événements en parallèle
    const allEventsArrays = await Promise.all(eventsPromises);

    // Filtrer les événements pour ne garder que ceux des 7 derniers jours
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    // Aplatir et filtrer
    const allEvents = allEventsArrays
      .flat()
      .filter((entry) => entry.timestamp >= sevenDaysAgo);

    // Trier par timestamp (du plus ancien au plus récent)
    allEvents.sort((a, b) => a.timestamp - b.timestamp);

    return allEvents;
  } catch (error) {
    logger.warn("Erreur lors de la récupération des événements des 7 derniers jours", {
      error: error.message,
      prefix,
    });
    return [];
  }
}

/**
 * Ferme la connexion Redis proprement
 * @returns {Promise<void>}
 */
export async function closeRedisConnection() {
  if (redisClient && redisClient.isOpen) {
    try {
      await redisClient.quit();
      logger.debug("Connexion Redis fermée");
    } catch (error) {
      logger.warn("Erreur lors de la fermeture de Redis", {
        error: error.message,
      });
    }
    redisClient = null;
  }
  isConnecting = false;
  connectionPromise = null;
}
