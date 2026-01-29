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
 * @param {number} maxLogs - Nombre maximum de logs à garder par jour (défaut: 5000)
 * @returns {Promise<boolean>} True si stocké avec succès, false sinon
 */
/**
 * Génère un hash simple pour un log (pour éviter les doublons)
 * @param {string} logLine - Ligne de log
 * @returns {string} Hash du log
 */
function hashLogLine(logLine) {
  if (!logLine || typeof logLine !== "string") {
    return "";
  }

  // Utiliser un hash simple basé sur le contenu du log
  // Pour les logs HAProxy, on peut utiliser le JSON s'il existe
  try {
    const jsonMatch = logLine.match(/\{.*\}/);
    if (jsonMatch) {
      // Si c'est un log JSON, utiliser le JSON comme identifiant unique
      return jsonMatch[0];
    }
  } catch (error) {
    // Ignorer les erreurs de parsing
  }
  // Sinon, utiliser la ligne complète comme identifiant
  return logLine.trim();
}

export async function storeLog(
  key,
  logLine,
  ttlSeconds = 86400,
  maxLogs = 5000
) {
  try {
    const client = await getRedisClient();
    if (!client) {
      return false; // Redis non disponible, continuer sans cache
    }

    // Générer un identifiant unique pour ce log (pour éviter les doublons)
    const logHash = hashLogLine(logLine);
    const logId = `log:${Buffer.from(logHash)
      .toString("base64")
      .substring(0, 50)}`;

    // Utiliser un Set Redis pour stocker les IDs des logs déjà stockés (déduplication)
    const seenKey = `${key}:seen`;
    const isSeen = await client.sIsMember(seenKey, logId);

    if (isSeen) {
      // Log déjà stocké, ne pas le stocker à nouveau
      logger.debug("Log déjà en cache, ignoré", {
        key,
        logId: logId.substring(0, 20),
      });
      return true; // Retourner true car le log existe déjà
    }

    // Utiliser une liste Redis pour stocker les logs (LPUSH pour ajouter au début)
    // Chaque élément de la liste est un JSON avec timestamp et logLine
    const logEntry = JSON.stringify({
      timestamp: Date.now(),
      log: logLine,
      id: logId, // Ajouter l'ID pour faciliter la déduplication
    });

    // Ajouter le log au début de la liste
    await client.lPush(key, logEntry);

    // Marquer ce log comme vu dans le Set
    await client.sAdd(seenKey, logId);

    // Limiter la taille de la liste pour éviter qu'elle ne devienne trop grande
    // On garde les N derniers logs (les plus récents sont au début avec lPush)
    if (maxLogs > 0) {
      await client.lTrim(key, 0, maxLogs - 1);

      // Nettoyer le Set des IDs vus pour éviter qu'il ne devienne trop grand
      // On garde seulement les IDs des logs qui sont encore dans la liste
      const listLength = await client.lLen(key);
      if (listLength > 0) {
        const logs = await client.lRange(key, 0, listLength - 1);
        const currentIds = new Set();
        logs.forEach((entry) => {
          try {
            const parsed = JSON.parse(entry);
            if (parsed.id) {
              currentIds.add(parsed.id);
            }
          } catch (error) {
            // Ignorer les erreurs de parsing
          }
        });

        // Récupérer tous les IDs du Set et supprimer ceux qui ne sont plus dans la liste
        const allSeenIds = await client.sMembers(seenKey);
        const idsToRemove = allSeenIds.filter((id) => !currentIds.has(id));
        if (idsToRemove.length > 0) {
          await client.sRem(seenKey, idsToRemove);
        }
      }
    }

    // Définir le TTL sur la clé et le Set
    await client.expire(key, ttlSeconds);
    await client.expire(seenKey, ttlSeconds);

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
 * @param {number} limit - Nombre maximum de logs à récupérer (défaut: 5000)
 * @returns {Promise<Array<{timestamp: number, log: string}>>} Liste des logs en cache (du plus ancien au plus récent)
 */
export async function getCachedLogs(key, limit = 5000) {
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
 * @param {number} limitPerDay - Nombre maximum de logs par jour (défaut: 5000)
 * @returns {Promise<Array<{timestamp: number, log: string}>>} Liste des logs en cache (du plus ancien au plus récent)
 */
export async function getCachedLogsLast24h(prefix, limitPerDay = 5000) {
  try {
    const client = await getRedisClient();
    if (!client) {
      return [];
    }

    // Générer les clés pour aujourd'hui et hier
    const now = Date.now();
    const today = new Date(now);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const todayKey = generateLogKey(prefix, today);
    const yesterdayKey = generateLogKey(prefix, yesterday);

    // Récupérer les logs d'hier et d'aujourd'hui en parallèle
    const [yesterdayLogs, todayLogs] = await Promise.all([
      getCachedLogs(yesterdayKey, limitPerDay),
      getCachedLogs(todayKey, limitPerDay),
    ]);

    logger.debug("Récupération des logs en cache", {
      prefix,
      yesterdayKey,
      todayKey,
      yesterdayCount: yesterdayLogs.length,
      todayCount: todayLogs.length,
    });

    // Filtrer les logs d'hier pour ne garder que ceux des dernières 24h
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
    const filteredYesterdayLogs = yesterdayLogs.filter(
      (log) => log.timestamp >= twentyFourHoursAgo
    );

    // Combiner tous les logs
    const allLogs = [...filteredYesterdayLogs, ...todayLogs];

    // Dédupliquer les logs basés sur leur ID (si présent) ou leur contenu
    const seenIds = new Set();
    const deduplicatedLogs = allLogs.filter((log) => {
      // Utiliser l'ID si présent, sinon utiliser le hash du log
      const logId = log.id || hashLogLine(log.log || "");
      if (seenIds.has(logId)) {
        return false; // Doublon, ignorer
      }
      seenIds.add(logId);
      return true;
    });

    // Trier par timestamp (du plus ancien au plus récent)
    deduplicatedLogs.sort((a, b) => a.timestamp - b.timestamp);

    logger.debug("Logs en cache récupérés et dédupliqués", {
      prefix,
      totalBeforeDedup: allLogs.length,
      totalAfterDedup: deduplicatedLogs.length,
      duplicatesRemoved: allLogs.length - deduplicatedLogs.length,
    });

    return deduplicatedLogs;
  } catch (error) {
    logger.warn("Erreur lors de la récupération des logs des dernières 24h", {
      error: error.message,
      prefix,
      stack: error.stack,
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
 * Génère un hash simple pour un événement d'activité (pour éviter les doublons)
 * @param {Object} event - Événement d'activité
 * @returns {string} Hash de l'événement
 */
function hashActivityEvent(event) {
  if (!event || typeof event !== "object") {
    return "";
  }

  // Utiliser les propriétés principales de l'événement pour créer un identifiant unique
  // eventType + source + timestamp + metadata clés (username, ip, container, etc.)
  const keyParts = [event.eventType, event.source, event.timestamp];

  // Ajouter les métadonnées importantes pour la déduplication
  if (event.metadata) {
    if (event.metadata.username) keyParts.push(event.metadata.username);
    if (event.metadata.ip) keyParts.push(event.metadata.ip);
    if (event.metadata.container) keyParts.push(event.metadata.container);
  }

  return keyParts.join("|");
}

/**
 * Stocke un événement d'activité dans Redis avec un TTL de 7 jours
 * @param {string} key - Clé Redis (ex: "activity:events:2025-12-10")
 * @param {Object} event - Événement à stocker
 * @param {number} ttlSeconds - TTL en secondes (défaut: 7 jours = 604800)
 * @param {number} maxEvents - Nombre maximum d'événements à garder par jour (défaut: 5000)
 * @returns {Promise<boolean>} True si stocké avec succès, false sinon
 */
export async function storeActivityEvent(
  key,
  event,
  ttlSeconds = 604800, // 7 jours
  maxEvents = 5000
) {
  try {
    const client = await getRedisClient();
    if (!client) {
      return false; // Redis non disponible, continuer sans cache
    }

    // Générer un identifiant unique pour cet événement (pour éviter les doublons)
    const eventHash = hashActivityEvent(event);
    const eventId = `event:${Buffer.from(eventHash)
      .toString("base64")
      .substring(0, 50)}`;

    // Utiliser un Set Redis pour stocker les IDs des événements déjà stockés (déduplication)
    const seenKey = `${key}:seen`;
    const isSeen = await client.sIsMember(seenKey, eventId);

    if (isSeen) {
      // Événement déjà stocké, ne pas le stocker à nouveau
      logger.debug("Événement déjà en cache, ignoré", {
        key,
        eventId: eventId.substring(0, 20),
        eventType: event.eventType,
      });
      return true; // Retourner true car l'événement existe déjà
    }

    // Utiliser une liste Redis pour stocker les événements (LPUSH pour ajouter au début)
    // Chaque élément de la liste est un JSON avec timestamp et event
    const eventEntry = JSON.stringify({
      timestamp: event.timestamp
        ? new Date(event.timestamp).getTime()
        : Date.now(),
      event,
      id: eventId, // Ajouter l'ID pour faciliter la déduplication
    });

    // Ajouter l'événement au début de la liste
    await client.lPush(key, eventEntry);

    // Marquer cet événement comme vu dans le Set
    await client.sAdd(seenKey, eventId);

    // Limiter la taille de la liste pour éviter qu'elle ne devienne trop grande
    // On garde les N derniers événements (les plus récents sont au début avec lPush)
    if (maxEvents > 0) {
      await client.lTrim(key, 0, maxEvents - 1);

      // Nettoyer le Set des IDs vus pour éviter qu'il ne devienne trop grand
      // On garde seulement les IDs des événements qui sont encore dans la liste
      const listLength = await client.lLen(key);
      if (listLength > 0) {
        const events = await client.lRange(key, 0, listLength - 1);
        const currentIds = new Set();
        events.forEach((entry) => {
          try {
            const parsed = JSON.parse(entry);
            if (parsed.id) {
              currentIds.add(parsed.id);
            }
          } catch (error) {
            // Ignorer les erreurs de parsing
          }
        });

        // Récupérer tous les IDs du Set et supprimer ceux qui ne sont plus dans la liste
        const allSeenIds = await client.sMembers(seenKey);
        const idsToRemove = allSeenIds.filter((id) => !currentIds.has(id));
        if (idsToRemove.length > 0) {
          await client.sRem(seenKey, idsToRemove);
        }
      }
    }

    // Définir le TTL sur la clé et le Set
    await client.expire(key, ttlSeconds);
    await client.expire(seenKey, ttlSeconds);

    return true;
  } catch (error) {
    logger.warn(
      "Erreur lors du stockage d'un événement d'activité dans Redis",
      {
        error: error.message,
        key,
      }
    );
    return false;
  }
}

/**
 * Récupère les événements d'activité en cache depuis Redis
 * @param {string} key - Clé Redis (ex: "activity:events:2025-12-10")
 * @param {number} limit - Nombre maximum d'événements à récupérer (défaut: 5000)
 * @returns {Promise<Array<{timestamp: number, event: Object}>>} Liste des événements en cache (du plus ancien au plus récent)
 */
export async function getCachedActivityEvents(key, limit = 5000) {
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
 * @param {number} limitPerDay - Nombre maximum d'événements par jour (défaut: 5000)
 * @returns {Promise<Array<{timestamp: number, event: Object}>>} Liste des événements en cache (du plus ancien au plus récent)
 */
export async function getCachedActivityEventsLast7Days(
  prefix,
  limitPerDay = 5000
) {
  try {
    const client = await getRedisClient();
    if (!client) {
      return [];
    }

    // Générer les clés pour les 7 derniers jours
    const now = Date.now();
    const today = new Date(now);
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

    logger.debug("Récupération des événements en cache", {
      prefix,
      keys,
      counts: allEventsArrays.map((arr) => arr.length),
    });

    // Filtrer les événements pour ne garder que ceux des 7 derniers jours
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    // Aplatir et filtrer
    const allEvents = allEventsArrays
      .flat()
      .filter((entry) => entry.timestamp >= sevenDaysAgo);

    // Dédupliquer les événements basés sur leur ID (si présent) ou leur hash
    const seenIds = new Set();
    const deduplicatedEvents = allEvents.filter((entry) => {
      // Utiliser l'ID si présent, sinon utiliser le hash de l'événement
      const eventId = entry.id || hashActivityEvent(entry.event || {});
      if (seenIds.has(eventId)) {
        return false; // Doublon, ignorer
      }
      seenIds.add(eventId);
      return true;
    });

    // Trier par timestamp (du plus ancien au plus récent)
    deduplicatedEvents.sort((a, b) => a.timestamp - b.timestamp);

    logger.debug("Événements en cache récupérés et dédupliqués", {
      prefix,
      totalBeforeDedup: allEvents.length,
      totalAfterDedup: deduplicatedEvents.length,
      duplicatesRemoved: allEvents.length - deduplicatedEvents.length,
    });

    return deduplicatedEvents;
  } catch (error) {
    logger.warn(
      "Erreur lors de la récupération des événements des 7 derniers jours",
      {
        error: error.message,
        prefix,
        stack: error.stack,
      }
    );
    return [];
  }
}

/**
 * Génère un hash simple pour une métrique (pour éviter les doublons)
 * @param {Object} metric - Métrique système
 * @returns {string} Hash de la métrique
 */
function hashMetric(metric) {
  if (!metric || typeof metric !== "object") {
    return "";
  }

  // Utiliser timestamp + hostname comme identifiant unique
  const keyParts = [
    metric.timestamp || Date.now(),
    metric.hostname || "unknown",
  ];

  return keyParts.join("|");
}

/**
 * Stocke une métrique système dans Redis avec un TTL de 24h
 * @param {string} key - Clé Redis (ex: "metrics:system:2025-12-10")
 * @param {Object} metric - Métrique à stocker
 * @param {number} ttlSeconds - TTL en secondes (défaut: 24h = 86400)
 * @param {number} maxMetrics - Nombre maximum de métriques à garder par jour (défaut: 8640 = 24h avec collecte toutes les 10s)
 * @returns {Promise<boolean>} True si stocké avec succès, false sinon
 */
export async function storeMetric(
  key,
  metric,
  ttlSeconds = 86400, // 24h
  maxMetrics = 8640 // 24h * 60min * 60sec / 10sec = 8640 métriques max
) {
  try {
    const client = await getRedisClient();
    if (!client) {
      return false; // Redis non disponible, continuer sans cache
    }

    // Générer un identifiant unique pour cette métrique (pour éviter les doublons)
    const metricHash = hashMetric(metric);
    const metricId = `metric:${Buffer.from(metricHash)
      .toString("base64")
      .substring(0, 50)}`;

    // Utiliser un Set Redis pour stocker les IDs des métriques déjà stockées (déduplication)
    const seenKey = `${key}:seen`;
    const isSeen = await client.sIsMember(seenKey, metricId);

    if (isSeen) {
      // Métrique déjà stockée, ne pas la stocker à nouveau
      logger.debug("Métrique déjà en cache, ignorée", {
        key,
        metricId: metricId.substring(0, 20),
      });
      return true; // Retourner true car la métrique existe déjà
    }

    // Utiliser une liste Redis pour stocker les métriques (LPUSH pour ajouter au début)
    // Chaque élément de la liste est un JSON avec timestamp et metric
    const metricEntry = JSON.stringify({
      timestamp: metric.timestamp
        ? new Date(metric.timestamp).getTime()
        : Date.now(),
      metric,
      id: metricId, // Ajouter l'ID pour faciliter la déduplication
    });

    // Ajouter la métrique au début de la liste
    await client.lPush(key, metricEntry);

    // Marquer cette métrique comme vue dans le Set
    await client.sAdd(seenKey, metricId);

    // Limiter la taille de la liste pour éviter qu'elle ne devienne trop grande
    // On garde les N dernières métriques (les plus récentes sont au début avec lPush)
    if (maxMetrics > 0) {
      await client.lTrim(key, 0, maxMetrics - 1);

      // Nettoyer le Set des IDs vus pour éviter qu'il ne devienne trop grand
      // On garde seulement les IDs des métriques qui sont encore dans la liste
      const listLength = await client.lLen(key);
      if (listLength > 0) {
        const metrics = await client.lRange(key, 0, listLength - 1);
        const currentIds = new Set();
        metrics.forEach((entry) => {
          try {
            const parsed = JSON.parse(entry);
            if (parsed.id) {
              currentIds.add(parsed.id);
            }
          } catch (error) {
            // Ignorer les erreurs de parsing
          }
        });

        // Récupérer tous les IDs du Set et supprimer ceux qui ne sont plus dans la liste
        const allSeenIds = await client.sMembers(seenKey);
        const idsToRemove = allSeenIds.filter((id) => !currentIds.has(id));
        if (idsToRemove.length > 0) {
          await client.sRem(seenKey, idsToRemove);
        }
      }
    }

    // Définir le TTL sur la clé et le Set
    await client.expire(key, ttlSeconds);
    await client.expire(seenKey, ttlSeconds);

    return true;
  } catch (error) {
    logger.warn("Erreur lors du stockage d'une métrique dans Redis", {
      error: error.message,
      key,
    });
    return false;
  }
}

/**
 * Récupère les métriques en cache depuis Redis
 * @param {string} key - Clé Redis (ex: "metrics:system:2025-12-10")
 * @param {number} limit - Nombre maximum de métriques à récupérer (défaut: 8640)
 * @returns {Promise<Array<{timestamp: number, metric: Object}>>} Liste des métriques en cache (du plus ancien au plus récent)
 */
export async function getCachedMetrics(key, limit = 8640) {
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
    const metrics = await client.lRange(key, startIndex, -1);

    // Inverser l'ordre car lPush ajoute au début, donc les plus anciens sont à la fin
    metrics.reverse();

    // Parser chaque entrée JSON
    const parsedMetrics = metrics
      .map((entry) => {
        try {
          return JSON.parse(entry);
        } catch (error) {
          logger.debug("Erreur lors du parsing d'une métrique en cache", {
            error: error.message,
          });
          return null;
        }
      })
      .filter((entry) => entry !== null);

    return parsedMetrics;
  } catch (error) {
    logger.warn("Erreur lors de la récupération des métriques en cache", {
      error: error.message,
      key,
    });
    return [];
  }
}

/**
 * Récupère les métriques en cache pour une période spécifiée depuis Redis
 * @param {string} prefix - Préfixe de la clé (ex: "metrics:system")
 * @param {number} hoursBack - Nombre d'heures en arrière (ex: 0.5 pour 30min, 1 pour 1h, 12 pour 12h, 24 pour 24h)
 * @param {number} limitPerDay - Nombre maximum de métriques par jour (défaut: 8640)
 * @returns {Promise<Array<{timestamp: number, metric: Object}>>} Liste des métriques en cache (du plus ancien au plus récent)
 */
export async function getCachedMetricsForPeriod(
  prefix,
  hoursBack,
  limitPerDay = 8640
) {
  try {
    const client = await getRedisClient();
    if (!client) {
      return [];
    }

    const now = Date.now();
    const cutoffTime = now - hoursBack * 60 * 60 * 1000;

    // Déterminer combien de jours nous devons récupérer
    // Si hoursBack <= 24, on a besoin d'aujourd'hui et peut-être d'hier
    const today = new Date(now);
    const keys = [];
    const metricsPromises = [];

    // Si on demande moins de 24h, on récupère seulement aujourd'hui
    if (hoursBack <= 24) {
      const todayKey = generateLogKey(prefix, today);
      keys.push(todayKey);
      metricsPromises.push(getCachedMetrics(todayKey, limitPerDay));

      // Si la période dépasse minuit, on récupère aussi hier
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayKey = generateLogKey(prefix, yesterday);
      keys.push(yesterdayKey);
      metricsPromises.push(getCachedMetrics(yesterdayKey, limitPerDay));
    } else {
      // Pour plus de 24h, récupérer plusieurs jours
      const daysNeeded = Math.ceil(hoursBack / 24);
      for (let i = 0; i <= daysNeeded; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const key = generateLogKey(prefix, date);
        keys.push(key);
        metricsPromises.push(getCachedMetrics(key, limitPerDay));
      }
    }

    // Récupérer toutes les métriques en parallèle
    const allMetricsArrays = await Promise.all(metricsPromises);

    logger.debug("Récupération des métriques en cache", {
      prefix,
      hoursBack,
      keys,
      counts: allMetricsArrays.map((arr) => arr.length),
    });

    // Aplatir et filtrer par timestamp
    const allMetrics = allMetricsArrays
      .flat()
      .filter((entry) => entry.timestamp >= cutoffTime);

    // Dédupliquer les métriques basées sur leur ID (si présent) ou leur hash
    const seenIds = new Set();
    const deduplicatedMetrics = allMetrics.filter((entry) => {
      // Utiliser l'ID si présent, sinon utiliser le hash de la métrique
      const metricId = entry.id || hashMetric(entry.metric || {});
      if (seenIds.has(metricId)) {
        return false; // Doublon, ignorer
      }
      seenIds.add(metricId);
      return true;
    });

    // Trier par timestamp (du plus ancien au plus récent)
    deduplicatedMetrics.sort((a, b) => a.timestamp - b.timestamp);

    logger.debug("Métriques en cache récupérées et dédupliquées", {
      prefix,
      hoursBack,
      totalBeforeDedup: allMetrics.length,
      totalAfterDedup: deduplicatedMetrics.length,
      duplicatesRemoved: allMetrics.length - deduplicatedMetrics.length,
    });

    return deduplicatedMetrics;
  } catch (error) {
    logger.warn(
      "Erreur lors de la récupération des métriques pour la période",
      {
        error: error.message,
        prefix,
        hoursBack,
        stack: error.stack,
      }
    );
    return [];
  }
}

/**
 * Récupère les métriques en cache des dernières 30 minutes depuis Redis
 * @param {string} prefix - Préfixe de la clé (ex: "metrics:system")
 * @param {number} limitPerDay - Nombre maximum de métriques par jour (défaut: 8640)
 * @returns {Promise<Array<{timestamp: number, metric: Object}>>} Liste des métriques en cache (du plus ancien au plus récent)
 */
export async function getCachedMetricsLast30Minutes(prefix, limitPerDay = 8640) {
  return getCachedMetricsForPeriod(prefix, 0.5, limitPerDay);
}

/**
 * Récupère les métriques en cache de la dernière heure depuis Redis
 * @param {string} prefix - Préfixe de la clé (ex: "metrics:system")
 * @param {number} limitPerDay - Nombre maximum de métriques par jour (défaut: 8640)
 * @returns {Promise<Array<{timestamp: number, metric: Object}>>} Liste des métriques en cache (du plus ancien au plus récent)
 */
export async function getCachedMetricsLast1Hour(prefix, limitPerDay = 8640) {
  return getCachedMetricsForPeriod(prefix, 1, limitPerDay);
}

/**
 * Récupère les métriques en cache des dernières 12h depuis Redis
 * @param {string} prefix - Préfixe de la clé (ex: "metrics:system")
 * @param {number} limitPerDay - Nombre maximum de métriques par jour (défaut: 8640)
 * @returns {Promise<Array<{timestamp: number, metric: Object}>>} Liste des métriques en cache (du plus ancien au plus récent)
 */
export async function getCachedMetricsLast12Hours(prefix, limitPerDay = 8640) {
  return getCachedMetricsForPeriod(prefix, 12, limitPerDay);
}

/**
 * Récupère les métriques en cache des dernières 24h depuis Redis
 * @param {string} prefix - Préfixe de la clé (ex: "metrics:system")
 * @param {number} limitPerDay - Nombre maximum de métriques par jour (défaut: 8640)
 * @returns {Promise<Array<{timestamp: number, metric: Object}>>} Liste des métriques en cache (du plus ancien au plus récent)
 */
export async function getCachedMetricsLast24h(prefix, limitPerDay = 8640) {
  return getCachedMetricsForPeriod(prefix, 24, limitPerDay);
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
