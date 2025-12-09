import http from "http";
import https from "https";
import { logger } from "../shared/logger.js";

const API_VERIFY_URL = "https://devoups.elyamaje.com/api/token";
const VERIFY_TIMEOUT = 5000; // 5 secondes

/**
 * Vérifie un token JWT via l'API de vérification
 *
 * @param {string} token - Token JWT à vérifier
 * @returns {Promise<{valid: boolean, userId?: string, email?: string, error?: string}>}
 */
export async function verifyToken(token) {
  if (!token) {
    return { valid: false, error: "Token manquant" };
  }

  const url = new URL(API_VERIFY_URL);
  url.searchParams.set("verify", token);

  return new Promise((resolve) => {
    const client = url.protocol === "https:" ? https : http;

    const req = client.get(
      url.toString(),
      { timeout: VERIFY_TIMEOUT },
      (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode === 200 && result.valid === true) {
              logger.debug("Token vérifié avec succès", {
                userId: result.userId,
                email: result.email,
              });
              resolve({
                valid: true,
                userId: result.userId,
                email: result.email,
              });
            } else {
              logger.warn("Token invalide selon l'API", {
                error: result.error,
                statusCode: res.statusCode,
              });
              resolve({
                valid: false,
                error: result.error || "Token invalide",
              });
            }
          } catch (error) {
            logger.error("Erreur parsing réponse API", {
              error: error.message,
              data,
              statusCode: res.statusCode,
            });
            resolve({ valid: false, error: "Erreur parsing réponse" });
          }
        });
      }
    );

    req.on("error", (error) => {
      logger.error("Erreur réseau lors de la vérification du token", {
        error: error.message,
        code: error.code,
      });
      resolve({ valid: false, error: "Erreur réseau" });
    });

    req.on("timeout", () => {
      req.destroy();
      logger.warn("Timeout lors de la vérification du token");
      resolve({ valid: false, error: "Timeout" });
    });

    req.setTimeout(VERIFY_TIMEOUT);
  });
}
