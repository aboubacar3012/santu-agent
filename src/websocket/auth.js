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
 * URL de base de l'API backend pour les vérifications de rôles
 * Cette URL est utilisée pour récupérer le rôle d'un utilisateur
 */
const API_BASE_URL = process.env.API_BASE_URL || "https://devoups.elyamaje.com";

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
 * @returns {{valid: boolean, userId?: string, companyId?: string, error?: string}}
 *   - valid: true si le token est valide, false sinon
 *   - userId: ID de l'utilisateur extrait du token (si valide)
 *   - companyId: ID de l'entreprise extrait du token (si valide)
 *   - error: Message d'erreur (si invalide)
 *
 * @example
 * const result = verifyToken("<base64>", "server-prod", "192.168.1.100");
 * if (!result.valid) console.error(result.error);
 * else console.log("User:", result.userId, "Company:", result.companyId);
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
    const tokenUserId = payload.userId; // userId inclus dans le token
    const tokenCompanyId = payload.companyId; // companyId inclus dans le token
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
      userId: tokenUserId,
      companyId: tokenCompanyId,
    });

    return {
      valid: true,
      userId: tokenUserId, // Retourner le userId extrait du token
      companyId: tokenCompanyId, // Retourner le companyId extrait du token
    };
  } catch (error) {
    logger.error("Erreur lors de la vérification du token", {
      error: error.message,
      name: error.name,
    });
    return { valid: false, error: "Erreur vérification token" };
  }
}

/**
 * Vérifie si un utilisateur a un des rôles autorisés en interrogeant l'API backend
 *
 * Cette fonction fait un appel HTTP à l'API backend pour récupérer le rôle d'un utilisateur
 * et vérifie si ce rôle est présent dans la liste des rôles autorisés.
 *
 * @param {string} userId - ID de l'utilisateur dont on veut vérifier le rôle
 * @param {string[]} allowedRoles - Tableau des rôles autorisés (ex: ["ADMIN", "OWNER", "EDITOR"])
 * @param {Object} [options] - Options supplémentaires
 * @param {string} [options.companyId] - ID de l'entreprise (requis pour vérifier le rôle dans une entreprise spécifique)
 * @returns {Promise<{authorized: boolean, role?: string, error?: string}>}
 *   - authorized: true si l'utilisateur a un des rôles autorisés, false sinon
 *   - role: Le rôle de l'utilisateur (si récupéré avec succès)
 *   - error: Message d'erreur (si la vérification échoue)
 *
 * @example
 * // Utilisation avec companyId
 * const result = await verifyRole("user-123", ["ADMIN", "OWNER"], {
 *   companyId: "company-123"
 * });
 * if (!result.authorized) {
 *   console.error("Accès refusé:", result.error);
 * }
 */
export async function verifyRole(userId, allowedRoles, options = {}) {
  // Vérifications préliminaires
  if (!userId) {
    logger.warn("verifyRole appelé sans userId");
    return {
      authorized: false,
      error: "userId requis pour la vérification du rôle",
    };
  }

  if (
    !allowedRoles ||
    !Array.isArray(allowedRoles) ||
    allowedRoles.length === 0
  ) {
    logger.warn("verifyRole appelé sans rôles autorisés", {
      allowedRoles,
    });
    return {
      authorized: false,
      error: "Liste de rôles autorisés requise",
    };
  }

  // Vérifier que companyId est fourni
  const companyId = options.companyId;
  if (!companyId) {
    logger.warn("verifyRole appelé sans companyId");
    return {
      authorized: false,
      error: "companyId requis pour la vérification du rôle",
    };
  }

  logger.debug("Vérification du rôle de l'utilisateur", {
    userId,
    companyId,
    allowedRoles,
  });

  try {
    // Construire l'URL de l'API pour récupérer le rôle avec le companyId en query parameter
    const apiUrl = `${API_BASE_URL}/api/users/${userId}/role?companyId=${encodeURIComponent(
      companyId
    )}`;

    logger.debug("Appel API pour récupérer le rôle", {
      apiUrl,
      userId,
      companyId,
    });

    // Préparer les headers avec authentification si disponible
    const headers = {
      "Content-Type": "application/json",
    };

    // Faire l'appel HTTP à l'API backend
    const response = await fetch(apiUrl, {
      method: "GET",
      headers,
      // Timeout de 5 secondes pour éviter les blocages
      signal: AbortSignal.timeout(5000),
    });

    // Vérifier le statut HTTP
    if (!response.ok) {
      const errorText = await response.text();
      logger.warn("Erreur lors de la récupération du rôle", {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
        userId,
      });

      if (response.status === 404) {
        return {
          authorized: false,
          error: "Utilisateur non trouvé dans cette entreprise",
        };
      }

      if (response.status === 401) {
        return {
          authorized: false,
          error: "Non authentifié",
        };
      }

      return {
        authorized: false,
        error: `Erreur API (${response.status}): ${errorText}`,
      };
    }

    // Parser la réponse JSON
    const data = await response.json();

    // Vérifier la structure de la réponse
    if (!data.success || !data.data || !data.data.role) {
      return {
        authorized: false,
        error: "Réponse API invalide",
      };
    }

    const userRole = data.data.role;

    logger.debug("Rôle récupéré avec succès", {
      userId,
      userRole,
      allowedRoles,
    });

    // Vérifier si le rôle de l'utilisateur est dans la liste des rôles autorisés
    const isAuthorized = allowedRoles.includes(userRole);

    if (!isAuthorized) {
      logger.warn("Accès refusé: rôle non autorisé", {
        userId,
        userRole,
        allowedRoles,
      });
      return {
        authorized: false,
        role: userRole,
        error: `Accès refusé. Rôle requis: ${allowedRoles.join(
          ", "
        )}. Rôle actuel: ${userRole}`,
      };
    }

    logger.debug("Vérification du rôle réussie", {
      userId,
      userRole,
      allowedRoles,
    });

    return {
      authorized: true,
      role: userRole,
    };
  } catch (error) {
    // Gérer les erreurs réseau, timeout, etc.
    logger.error("Erreur lors de la vérification du rôle", {
      error: error.message,
      name: error.name,
      userId,
      allowedRoles,
    });

    // Détecter les erreurs de timeout spécifiquement
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return {
        authorized: false,
        error: "Timeout lors de la vérification du rôle",
      };
    }

    return {
      authorized: false,
      error: `Erreur lors de la vérification du rôle: ${error.message}`,
    };
  }
}
