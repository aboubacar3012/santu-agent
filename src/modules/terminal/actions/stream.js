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
 * @param {string} userEmail - Email de l'utilisateur connecté
 * @returns {Promise<string>} Nom d'utilisateur à utiliser
 */
async function ensureLimitedUser(userEmail) {
  // Générer le nom d'utilisateur à partir de l'email
  // Prendre la partie avant le @, remplacer les points par des tirets
  let username = "devoups-terminal"; // Valeur par défaut
  
  if (userEmail && typeof userEmail === "string" && userEmail.includes("@")) {
    const localPart = userEmail.split("@")[0];
    // Remplacer les points par des tirets et nettoyer les caractères spéciaux
    username = localPart
      .replace(/\./g, "-")
      .replace(/[^a-z0-9-]/gi, "")
      .toLowerCase();
    
    // S'assurer que le nom d'utilisateur est valide (commence par une lettre ou underscore)
    if (!/^[a-z_]/.test(username)) {
      username = "user-" + username;
    }
    
    // Limiter la longueur du nom d'utilisateur (max 32 caractères pour Linux)
    if (username.length > 32) {
      username = username.substring(0, 32);
    }
    
    logger.info(`Nom d'utilisateur généré depuis l'email: ${username}`);
  } else {
    logger.warn("Email invalide ou manquant, utilisation du nom par défaut");
  }
  
  try {
    // Vérifier si l'utilisateur existe déjà
    const checkUser = await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- id -u ${username} 2>/dev/null || echo "not_found"`,
      { timeout: 5000 },
    );

    if (checkUser.stdout.trim() === "not_found") {
      logger.info("Création de l'utilisateur limité pour le terminal");

      // Créer l'utilisateur avec un shell bash et un répertoire home
      const createUserResult = await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- useradd -m -s /bin/bash -c "Devoups Terminal User" ${username} 2>&1`,
        { timeout: 10000 },
      );

      // Logger le résultat de la création
      logger.debug(`Résultat création utilisateur ${username}:`, {
        stdout: createUserResult.stdout,
        stderr: createUserResult.stderr,
        exitCode: createUserResult.exitCode,
      });

      // Vérifier si la création a réussi
      if (
        createUserResult.exitCode !== 0 &&
        !createUserResult.stderr.includes("already exists")
      ) {
        logger.error(
          `Erreur lors de la création de l'utilisateur: ${createUserResult.stderr || createUserResult.stdout}`,
        );
      }

      // Vérifier que l'utilisateur existe maintenant
      const verifyUser = await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- id -u ${username} 2>/dev/null || echo "not_found"`,
        { timeout: 5000 },
      );

      if (verifyUser.stdout.trim() === "not_found") {
        throw new Error(`Impossible de créer l'utilisateur ${username}`);
      }

      // S'assurer que le répertoire home existe et a les bonnes permissions
      await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- mkdir -p /home/${username} && chown ${username}:${username} /home/${username} 2>&1`,
        { timeout: 5000 },
      );

      logger.info(`Utilisateur ${username} créé avec succès`);
    } else {
      logger.debug(`Utilisateur ${username} existe déjà`);

      // Vérifier que le répertoire home existe
      const homeCheck = await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- test -d /home/${username} && echo "exists" || echo "missing"`,
        { timeout: 3000 },
      );

      if (homeCheck.stdout.trim() === "missing") {
        logger.warn(`Répertoire home manquant pour ${username}, création...`);
        await executeCommand(
          `nsenter -t 1 -m -u -i -n -p -- mkdir -p /home/${username} && chown ${username}:${username} /home/${username} 2>&1`,
          { timeout: 5000 },
        );
      }
    }

    // Vérifier une dernière fois que le répertoire home existe avant de créer les fichiers
    const finalHomeCheck = await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- test -d /home/${username} && echo "exists" || echo "missing"`,
      { timeout: 3000 },
    );

    if (finalHomeCheck.stdout.trim() === "missing") {
      logger.error(
        `Répertoire home /home/${username} n'existe pas, impossible de continuer`,
      );
      throw new Error(`Répertoire home manquant pour ${username}`);
    }

    // Créer un .bashrc personnalisé simple sans MOTD
    const bashrcContent = `# Configuration Devoups Terminal User

# Couleurs pour ls
alias ls='ls --color=auto'
alias ll='ls -lah --color=auto'
`;

    // Créer le fichier .bashrc
    await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- sh -c 'cat > /home/${username}/.bashrc << 'BASHRC_EOF'
${bashrcContent}
BASHRC_EOF'`,
      { timeout: 5000 },
    );

    // Définir les permissions appropriées
    await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- chown ${username}:${username} /home/${username}/.bashrc 2>&1 || true`,
      { timeout: 5000 },
    );

    // Vérifier si l'utilisateur est dans le groupe docker et l'ajouter si nécessaire
    try {
      const checkDockerGroup = await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- groups ${username} 2>/dev/null | grep -q docker && echo "in_docker" || echo "not_in_docker"`,
        { timeout: 5000 },
      );

      if (checkDockerGroup.stdout.trim() === "not_in_docker") {
        logger.info(`Ajout de l'utilisateur ${username} au groupe docker`);
        await executeCommand(
          `nsenter -t 1 -m -u -i -n -p -- usermod -aG docker ${username} 2>&1 || true`,
          { timeout: 5000 },
        );
        logger.info(`Utilisateur ${username} ajouté au groupe docker`);
      } else {
        logger.debug(`Utilisateur ${username} est déjà dans le groupe docker`);
      }
    } catch (error) {
      logger.warn(
        "Erreur lors de l'ajout au groupe docker (le groupe docker peut ne pas exister)",
        {
          error: error.message,
        },
      );
    }

    // Vérification finale que l'utilisateur existe avant de retourner
    const finalCheck = await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- id -u ${username} 2>/dev/null || echo "not_found"`,
      { timeout: 5000 },
    );

    if (finalCheck.stdout.trim() === "not_found") {
      throw new Error(
        `L'utilisateur ${username} n'existe pas après la création`,
      );
    }

    return username;
  } catch (error) {
    logger.error("Erreur lors de la création de l'utilisateur limité", {
      error: error.message,
      stack: error.stack,
    });
    // Propager l'erreur au lieu de retourner "nobody" qui n'a pas de home
    throw error;
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
    const { cols, rows, userEmail } = validatedParams;

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
    const username = await ensureLimitedUser(userEmail);

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
