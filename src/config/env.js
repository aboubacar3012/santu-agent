/**
 * Configuration et validation des variables d'environnement
 * @module config/env
 */

import dotenv from "dotenv";

// Charger les variables d'environnement
dotenv.config();

/**
 * Charge et valide la configuration
 * @returns {Object} Configuration validée
 * @throws {Error} Si une variable requise est manquante
 */
export function loadConfig() {
  const required = ["AGENT_TOKEN", "AGENT_HOSTNAME"];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Variables d'environnement manquantes: ${missing.join(", ")}`
    );
  }

  const clientToken =
    process.env.AGENT_CLIENT_TOKEN || process.env.AGENT_TOKEN || null;

  return {
    token: process.env.AGENT_TOKEN,
    clientToken,
    hostname: process.env.AGENT_HOSTNAME,
    logLevel: process.env.AGENT_LOG_LEVEL || "info",
    dockerSocketPath: process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock",
    frontendPort: parseInt(process.env.AGENT_FRONTEND_PORT || "7081", 10),
    frontendHost: process.env.AGENT_FRONTEND_HOST || "0.0.0.0",
  };
}

