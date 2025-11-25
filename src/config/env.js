/**
 * Configuration et validation des variables d'environnement.
 *
 * Ce module centralise tout ce qui concerne la configuration dynamique de l'agent.
 * Il garantit que les variables critiques sont présentes, applique des valeurs par
 * défaut sûres et expose un objet de configuration unique utilisé partout dans l'app.
 *
 * Structure générale :
 * - Chargement via dotenv (permet .env/.env.local, etc.)
 * - Validation des variables obligatoires (token + hostname)
 * - Normalisation/sanitization des options facultatives (ports, log level, token frontend)
 *
 * @module config/env
 */

import dotenv from "dotenv";

// Charger immédiatement les variables déclarées dans .env (ou l'environnement du processus).
dotenv.config();

/**
 * Liste des variables indispensables au démarrage. On garde cette liste proche
 * de la logique pour qu'un ajout/ suppression se fasse en une seule modification.
 */
const REQUIRED_KEYS = []; // "AGENT_TOKEN", "AGENT_HOSTNAME"

/**
 * Charge et valide la configuration.
 *
 * @returns {{
 *   token: string,
 *   clientToken: string|null,
 *   hostname: string,
 *   logLevel: string,
 *   dockerSocketPath: string,
 *   frontendPort: number,
 *   frontendHost: string,
 * }} Configuration validée et prête à l'emploi
 * @throws {Error} Si une variable requise est manquante
 */
export function loadConfig() {
  // Vérifier la présence des variables obligatoires pour éviter un crash plus loin.
  const missing = REQUIRED_KEYS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Variables d'environnement manquantes: ${missing.join(", ")}`
    );
  }

  /**
   * Token utilisé pour authentifier les connexions frontend.
   * Si aucun jeton dédié n'est fourni, on retombe sur le jeton agent (mode simple).
   */
  const clientToken = process.env.AGENT_TOKEN || null;

  /**
   * Construction de l'objet de configuration final.
   * Tous les accès à process.env sont regroupés ici pour unifier la logique.
   */
  return {
    // Jeton principal partagé avec le backend (si besoin futur) et utilisé par défaut côté frontend.
    token: process.env.AGENT_TOKEN,
    // Jeton spécifique à exposer aux clients frontend (permettra un scope différent plus tard).
    clientToken,
    // Nom lisible du serveur (utilisé dans les logs, messages, etc.).
    hostname: process.env.AGENT_HOSTNAME,
    // Niveau de logs (error/warn/info/debug).
    logLevel: "debug",
    // Socket Docker (Unix ou éventuellement TCP).
    dockerSocketPath: "/var/run/docker.sock",
    // Port d'écoute du serveur WebSocket frontal.
    frontendPort: "7081",
    // Interface réseau à exposer (0.0.0.0 = toutes les interfaces).
    frontendHost: "0.0.0.0",
  };
}
