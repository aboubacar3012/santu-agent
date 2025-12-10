/**
 * Module d'authentification pour les connexions WebSocket
 *
 * Ce module gère la vérification des tokens envoyés par le frontend
 * en décodant localement le token sans appel API ni signature.
 *
 * Flux d'authentification :
 * 1. Le frontend génère un token simple contenant hostname, serverIp et timestamp (Epoch ms)
 * 2. Le frontend envoie ce token dans l'URL WebSocket : wss://...?token=xxx&hostname=yyy
 * 3. L'agent reçoit le token et appelle cette fonction pour le vérifier localement
 * 4. Cette fonction décode le token (Base64 JSON) et vérifie :
 *    - Expiration du token (validité 5 minutes)
 *    - Correspondance du hostname avec celui de l'agent
 *    - Correspondance de l'IP avec celle du serveur
 * 5. Si toutes les vérifications passent, la connexion WebSocket est acceptée
 */

import { logger } from "../shared/logger.js";

/**
 * Vérifie un token simple (Base64 JSON) localement sans appel API ni signature.
 *
 * Cette fonction décode et vérifie le token en vérifiant :
 * - L'expiration du token (pas expiré, valide 5 minutes)
 * - La correspondance du hostname avec celui de l'agent
 * - La correspondance de l'IP avec celle du serveur
 *
 * @param {string} token - Token à vérifier (reçu dans l'URL WebSocket)
 * @param {string} expectedHostname - Hostname attendu (celui de l'agent)
 * @param {string} expectedServerIp - IP attendue (celle du serveur)
 * @returns {{valid: boolean, userId?: string, email?: string, error?: string}}
 *   - valid: true si le token est valide, false sinon
 *   - error: Message d'erreur (si invalide)
 *
 * @example
 * const result = verifyToken("<base64>", "server-prod", "192.168.1.100");
 * if (!result.valid) console.error(result.error);
 */
export function verifyToken(token, expectedHostname, expectedServerIp) {
  // Vérification basique : le token doit être fourni
  if (!token) {
    logger.warn("Token manquant lors de la vérification");
    return { valid: false, error: "Token manquant" };
  }

  // Vérifier que le token est une chaîne non vide
  if (typeof token !== "string" || token.trim().length === 0) {
    logger.warn("Token invalide (vide ou non-string)", {
      tokenType: typeof token,
    });
    return { valid: false, error: "Token invalide" };
  }

  logger.debug("Vérification locale du token", {
    tokenLength: token.length,
    tokenPreview: token.substring(0, 20) + "...",
    expectedHostname,
    expectedServerIp,
  });

  try {
    // Décoder le token (Base64 JSON)
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const payload = JSON.parse(decoded);

    const tokenHostname = payload.hostname;
    const tokenServerIp = payload.serverIp;
    const ts = payload.ts; // timestamp en ms

    if (!tokenHostname || !tokenServerIp || !ts) {
      logger.warn("Token ne contient pas hostname, serverIp ou timestamp", {
        hasHostname: !!tokenHostname,
        hasServerIp: !!tokenServerIp,
        hasTs: !!ts,
      });
      return { valid: false, error: "Token malformé (champs manquants)" };
    }

    // Vérifier la fenêtre de temps (5 minutes)
    const now = Date.now();
    const MAX_AGE_MS = 5 * 60 * 1000;
    if (now - ts > MAX_AGE_MS || ts > now + 60 * 1000) {
      logger.warn("Token expiré ou horloge invalide", { ts, now });
      return { valid: false, error: "Token expiré" };
    }

    // Vérifier la correspondance du hostname
    if (tokenHostname !== expectedHostname) {
      logger.warn("Hostname du token ne correspond pas", {
        tokenHostname,
        expectedHostname,
      });
      return { valid: false, error: "Hostname incorrect" };
    }

    // Vérifier la correspondance de l'IP
    if (tokenServerIp !== expectedServerIp) {
      logger.warn("IP du token ne correspond pas", {
        tokenServerIp,
        expectedServerIp,
      });
      return { valid: false, error: "IP incorrecte" };
    }

    // Toutes les vérifications sont passées
    logger.debug("Token vérifié avec succès localement", {
      hostname: tokenHostname,
      serverIp: tokenServerIp,
    });

    return {
      valid: true,
    };
  } catch (error) {
    logger.error("Erreur lors de la vérification du token", {
      error: error.message,
      name: error.name,
    });
    return { valid: false, error: "Erreur vérification token" };
  }
}
