/**
 * Action stream - Crée un terminal interactif sur l'hôte
 *
 * @module modules/terminal/actions/stream
 */

import { spawn } from "child_process";
import { logger } from "../../../shared/logger.js";
import { validateTerminalParams } from "../validator.js";
import { requireRole } from "../../../websocket/auth.js";
import { executeCommand } from "../../../shared/executor.js";

/**
 * Crée un utilisateur limité pour le terminal si nécessaire
 * Restrictions appliquées :
 * - Pas d'accès root (sudo, su désactivés)
 * @returns {Promise<string>} Nom d'utilisateur à utiliser
 */
async function ensureLimitedUser() {
  const username = "devoups-temp-user";
  
  try {
    // Vérifier si l'utilisateur existe déjà
    const checkUser = await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- id -u ${username} 2>/dev/null || echo "not_found"`,
      { timeout: 5000 },
    );

    // Si l'utilisateur existe, le supprimer complètement pour éviter les limites résiduelles
    if (checkUser.stdout.trim() !== "not_found") {
      logger.info(`Suppression de l'utilisateur ${username} existant pour le recréer proprement`);
      
      try {
        // Tuer tous les processus de l'utilisateur
        await executeCommand(
          `nsenter -t 1 -m -u -i -n -p -- pkill -u ${username} 2>&1 || true`,
          { timeout: 3000 },
        );
        
        // Attendre un peu pour que les processus se terminent
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Supprimer l'utilisateur et son home
        await executeCommand(
          `nsenter -t 1 -m -u -i -n -p -- userdel -r ${username} 2>&1 || true`,
          { timeout: 5000 },
        );
        
        // Nettoyer les limites dans /etc/security/limits.conf
        await executeCommand(
          `nsenter -t 1 -m -u -i -n -p -- sed -i '/${username}/d' /etc/security/limits.conf 2>&1 || true`,
          { timeout: 3000 },
        );
        
        logger.info(`Utilisateur ${username} supprimé avec succès`);
      } catch (error) {
        logger.warn("Erreur lors de la suppression de l'utilisateur existant", {
          error: error.message,
        });
      }
    }

    // Créer l'utilisateur (soit nouveau, soit après suppression)
    const userExists = await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- id -u ${username} 2>/dev/null || echo "not_found"`,
      { timeout: 5000 },
    );

    if (userExists.stdout.trim() === "not_found") {
      logger.info("Création de l'utilisateur limité pour le terminal");

      // Créer l'utilisateur avec un shell bash
      await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- useradd -m -s /bin/bash -c "Devoups Temp User" ${username} 2>&1 || true`,
        { timeout: 10000 },
      );

      // Créer un répertoire home avec permissions appropriées
      await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- mkdir -p /home/${username} && chown ${username}:${username} /home/${username} 2>&1 || true`,
        { timeout: 5000 },
      );

      // Créer un .bashrc personnalisé pour empêcher l'accès root
      const bashrcContent = [
        "# Configuration Devoups Temp User",
        "",
        "# Afficher le MOTD au démarrage",
        'if [ -f "$HOME/.motd" ] && [ -z "$MOTD_SHOWN" ]; then',
        '  cat "$HOME/.motd"',
        "  export MOTD_SHOWN=1",
        "fi",
        "",
        "# Empêcher l'accès root",
        'alias sudo="echo Commande sudo désactivée - pas d accès root"',
        'alias su="echo Commande su désactivée - pas d accès root"',
      ].join("\n");

      // Créer le fichier .bashrc en utilisant printf pour gérer les caractères spéciaux
      await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- sh -c 'cat > /home/${username}/.bashrc << 'BASHRC_EOF'
${bashrcContent}
BASHRC_EOF'`,
        { timeout: 5000 },
      );

      // Créer le fichier MOTD
      const motdContent = [
        "",
        "╔══════════════════════════════════════════════════════════════╗",
        "║          Bienvenue sur le terminal Devoups                  ║",
        "╚══════════════════════════════════════════════════════════════╝",
        "",
        `👤 Utilisateur: ${username}`,
        "",
        "🚫 Restrictions:",
        "   - Pas d accès root (sudo et su désactivés)",
        "",
        "Pour plus d informations, contactez l administrateur système.",
        "",
        "═══════════════════════════════════════════════════════════════",
        "",
      ].join("\n");

      // Créer le fichier MOTD
      await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- sh -c 'cat > /home/${username}/.motd << 'MOTD_EOF'
${motdContent}
MOTD_EOF'`,
        { timeout: 5000 },
      );

      // Définir les permissions appropriées
      await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- chown ${username}:${username} /home/${username}/.bashrc /home/${username}/.motd 2>&1 || true`,
        { timeout: 5000 },
      );

      logger.info(
        `Utilisateur ${username} créé avec succès et restrictions appliquées`,
      );
    } else {
      logger.debug(`Utilisateur ${username} existe déjà`);
      
      // Nettoyer les anciennes limites de ressources si elles existent
      try {
        // Supprimer toutes les lignes contenant le nom d'utilisateur dans /etc/security/limits.conf
        await executeCommand(
          `nsenter -t 1 -m -u -i -n -p -- sed -i '/${username}/d' /etc/security/limits.conf 2>&1 || true`,
          { timeout: 5000 },
        );
        
        // Réinitialiser les quotas si configurés
        try {
          await executeCommand(
            `nsenter -t 1 -m -u -i -n -p -- setquota -u ${username} 0 0 0 0 / 2>&1 || true`,
            { timeout: 3000 },
          );
        } catch (quotaError) {
          // Ignorer si les quotas ne sont pas activés
        }
        
        logger.debug(`Anciennes limites nettoyées pour ${username}`);
      } catch (error) {
        logger.debug("Erreur lors du nettoyage des anciennes limites", {
          error: error.message,
        });
      }
      
      // Mettre à jour le .bashrc et .motd même si l'utilisateur existe déjà
      const bashrcContent = [
        "# Configuration Devoups Temp User",
        "",
        "# Afficher le MOTD au démarrage",
        'if [ -f "$HOME/.motd" ] && [ -z "$MOTD_SHOWN" ]; then',
        '  cat "$HOME/.motd"',
        "  export MOTD_SHOWN=1",
        "fi",
        "",
        "# Empêcher l'accès root",
        'alias sudo="echo Commande sudo désactivée - pas d accès root"',
        'alias su="echo Commande su désactivée - pas d accès root"',
      ].join("\n");

      await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- sh -c 'cat > /home/${username}/.bashrc << 'BASHRC_EOF'
${bashrcContent}
BASHRC_EOF'`,
        { timeout: 5000 },
      );

      const motdContent = [
        "",
        "╔══════════════════════════════════════════════════════════════╗",
        "║          Bienvenue sur le terminal Devoups                  ║",
        "╚══════════════════════════════════════════════════════════════╝",
        "",
        `👤 Utilisateur: ${username}`,
        "",
        "🚫 Restrictions:",
        "   - Pas d accès root (sudo et su désactivés)",
        "",
        "Pour plus d informations, contactez l administrateur système.",
        "",
        "═══════════════════════════════════════════════════════════════",
        "",
      ].join("\n");

      await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- sh -c 'cat > /home/${username}/.motd << 'MOTD_EOF'
${motdContent}
MOTD_EOF'`,
        { timeout: 5000 },
      );

      await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- chown ${username}:${username} /home/${username}/.bashrc /home/${username}/.motd 2>&1 || true`,
        { timeout: 5000 },
      );
    }

    return username;
  } catch (error) {
    logger.warn("Erreur lors de la création de l'utilisateur limité, utilisation de l'utilisateur par défaut", {
      error: error.message,
    });
    // Fallback: utiliser l'utilisateur courant ou un utilisateur système
    return "nobody";
  }
}

/**
 * Crée un terminal interactif sur l'hôte avec un utilisateur limité
 * @param {Object} params - Paramètres
 * @param {number} [params.cols=80] - Nombre de colonnes du terminal
 * @param {number} [params.rows=24] - Nombre de lignes du terminal
 * @param {Object} callbacks - Callbacks pour le streaming
 * @param {Function} callbacks.onStream - Callback pour les données de stream
 * @param {Function} callbacks.onResource - Callback pour enregistrer la ressource
 * @returns {Promise<Object>} Informations de stream
 */
export async function streamTerminal(params = {}, callbacks = {}) {
  try {
    // Vérifier les permissions : ADMIN, OWNER, EDITOR peuvent utiliser le terminal
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER", "EDITOR"],
      "utiliser le terminal",
    );

    const validatedParams = validateTerminalParams("stream", params);
    const { cols, rows } = validatedParams;

    if (!callbacks.onStream) {
      throw new Error(
        "onStream callback est requis pour le streaming du terminal",
      );
    }

    logger.info("Démarrage du terminal interactif sur l'hôte", {
      cols,
      rows,
      userId,
    });

    // Créer ou récupérer l'utilisateur limité
    const username = await ensureLimitedUser();

    // Créer un processus shell interactif via nsenter
    // Utiliser script pour créer un PTY interactif avec un shell bash
    // script -q -c "bash" crée un shell interactif avec PTY
    // -q = quiet (pas de message de démarrage)
    // -c = commande à exécuter
    const shellCommand = `nsenter -t 1 -m -u -i -n -p -- su - ${username} -c "script -q -c 'bash --login' /dev/null"`;

    const shellProcess = spawn("sh", ["-c", shellCommand], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: cols.toString(),
        LINES: rows.toString(),
      },
    });

    // Fonction de nettoyage
    const cleanup = () => {
      if (shellProcess && !shellProcess.killed) {
        try {
          shellProcess.kill("SIGTERM");
          // Attendre un peu puis forcer si nécessaire
          setTimeout(() => {
            if (!shellProcess.killed) {
              shellProcess.kill("SIGKILL");
            }
          }, 1000);
        } catch (error) {
          logger.debug("Erreur lors du nettoyage du processus shell", {
            error: error.message,
          });
        }
      }
    };

    // Gérer stdout (sortie du terminal)
    shellProcess.stdout.on("data", (chunk) => {
      try {
        callbacks.onStream("stdout", chunk.toString());
      } catch (error) {
        logger.error("Erreur lors de l'envoi des données stdout", {
          error: error.message,
        });
      }
    });

    // Gérer stderr (erreurs du terminal)
    shellProcess.stderr.on("data", (chunk) => {
      try {
        callbacks.onStream("stderr", chunk.toString());
      } catch (error) {
        logger.error("Erreur lors de l'envoi des données stderr", {
          error: error.message,
        });
      }
    });

    // Gérer la fin du processus
    shellProcess.on("exit", (code, signal) => {
      logger.info("Terminal fermé", { code, signal, userId });
      try {
        callbacks.onStream(
          "stdout",
          `\r\n[Terminal fermé avec le code ${code}]\r\n`,
        );
      } catch (error) {
        logger.debug("Erreur lors de l'envoi du message de fermeture", {
          error: error.message,
        });
      }
      cleanup();
    });

    // Gérer les erreurs du processus
    shellProcess.on("error", (error) => {
      logger.error("Erreur du processus shell", {
        error: error.message,
        userId,
      });
      try {
        callbacks.onStream(
          "stderr",
          `\r\n\x1b[31m[Erreur: ${error.message}]\x1b[0m\r\n`,
        );
      } catch (streamError) {
        logger.error("Erreur lors de l'envoi de l'erreur", {
          error: streamError.message,
        });
      }
    });

    // Fonction pour écrire dans le terminal (sera appelée depuis le WebSocket handler)
    const writeToTerminal = (data) => {
      if (shellProcess.stdin && !shellProcess.stdin.destroyed) {
        try {
          shellProcess.stdin.write(data);
        } catch (error) {
          logger.debug("Erreur lors de l'écriture dans le terminal", {
            error: error.message,
          });
        }
      }
    };

    // Fonction pour redimensionner le terminal
    const resizeTerminal = (newCols, newRows) => {
      if (shellProcess && !shellProcess.killed) {
        try {
          // Envoyer la séquence d'échappement ANSI pour redimensionner le terminal
          // Format: ESC[8;rows;colst
          const resizeCommand = `\x1b[8;${newRows};${newCols}t`;
          if (shellProcess.stdin && !shellProcess.stdin.destroyed) {
            shellProcess.stdin.write(resizeCommand);
          }

          // Mettre à jour les variables d'environnement (pour les processus enfants)
          if (shellProcess.stdin && !shellProcess.stdin.destroyed) {
            shellProcess.stdin.write(
              `export COLUMNS=${newCols} LINES=${newRows}\n`,
            );
          }
        } catch (error) {
          logger.debug("Erreur lors du redimensionnement du terminal", {
            error: error.message,
          });
        }
      }
    };

    // Envoyer un message initial
    callbacks.onStream(
      "stdout",
      `\r\n\x1b[32m[Terminal connecté - Utilisateur: ${username}]\x1b[0m\r\n`,
    );

    // Retourner les informations de stream avec les fonctions de contrôle
    return {
      isStreaming: true,
      initialResponse: {
        message: "Terminal connecté",
        username,
        cols,
        rows,
      },
      resource: {
        type: "terminal",
        process: shellProcess,
        write: writeToTerminal,
        resize: resizeTerminal,
        cleanup,
      },
    };
  } catch (error) {
    logger.error("Erreur lors de la création du terminal", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}
