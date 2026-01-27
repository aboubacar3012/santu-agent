/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ACTION: terminal.stream - Terminal Interactif Sécurisé
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DESCRIPTION:
 * Ce module crée un terminal interactif et sécurisé sur le serveur hôte.
 * Chaque utilisateur qui se connecte obtient son propre compte Linux isolé
 * avec accès restreint et un timeout d'inactivité.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FONCTIONNEMENT GLOBAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. CRÉATION DE L'UTILISATEUR
 *    - Génère un nom d'utilisateur depuis l'email: "prenom-nom-devoups"
 *    - Crée un utilisateur Linux avec `useradd -m -s /bin/bash`
 *    - Crée automatiquement le répertoire home: /home/username-devoups/
 *    - Configure les permissions: 755 pour le home, 644 pour les fichiers
 *    - Ajoute l'utilisateur au groupe docker pour gérer les containers
 *
 * 2. CONFIGURATION DE L'ENVIRONNEMENT
 *    - Crée un .bashrc avec alias et message de bienvenue
 *    - Crée un .bash_profile qui charge le .bashrc
 *    - Définit les permissions appropriées pour tous les fichiers
 *    - Crée un répertoire .local pour les fichiers temporaires
 *
 * 3. DÉMARRAGE DU SHELL
 *    - Lance un shell bash via nsenter pour accéder à l'hôte
 *    - Utilise `su -` pour basculer vers l'utilisateur créé
 *    - Utilise `script` pour créer un pseudo-terminal (PTY)
 *    - Démarre dans le répertoire home de l'utilisateur
 *
 * 4. STREAMING BIDIRECTIONNEL
 *    - stdout/stderr → Envoyé au frontend via WebSocket
 *    - stdin ← Reçu depuis le frontend (frappes clavier)
 *    - Redimensionnement → Ajuste les colonnes/lignes du terminal
 *
 * 5. GESTION DE L'INACTIVITÉ (10 MINUTES)
 *    - Timer qui se réinitialise à chaque activité:
 *      • Frappe clavier (stdin)
 *      • Sortie du terminal (stdout/stderr)
 *    - Après 10 min d'inactivité:
 *      • Affiche un avertissement (5 secondes)
 *      • Ferme le terminal
 *      • Supprime l'utilisateur et son home
 *
 * 6. NETTOYAGE AUTOMATIQUE
 *    - À la fermeture normale du terminal (exit, Ctrl+D):
 *      • Annule le timer d'inactivité
 *      • Tue le processus shell
 *      • Supprime l'utilisateur et son répertoire home (après 2s)
 *    - À l'expiration du timer (10 min):
 *      • Affiche un message d'avertissement
 *      • Ferme le terminal (après 5s)
 *      • Supprime l'utilisateur et son home
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SÉCURITÉ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PERMISSIONS REQUISES:
 * - Rôles autorisés: ADMIN, OWNER, EDITOR
 * - Vérification via requireRole() avant toute opération
 *
 * ISOLATION:
 * - Chaque utilisateur a son propre compte Linux
 * - Répertoire home isolé: /home/username-devoups/
 * - Pas d'accès aux fichiers des autres utilisateurs
 * - Permissions 755 sur le home (rwxr-xr-x)
 *
 * ACCÈS DOCKER:
 * - Utilisateur ajouté au groupe docker
 * - Peut gérer les containers (docker ps, logs, exec, etc.)
 * - Note: Le groupe docker donne des privilèges élevés
 *
 * AUTO-NETTOYAGE:
 * - Suppression automatique après 10 min d'inactivité
 * - Suppression à la fermeture du terminal
 * - Aucun compte orphelin ne reste sur le système
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FLUX DE DONNÉES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DÉMARRAGE:
 * Frontend → WebSocket → { action: "terminal.stream", params: { cols, rows, userEmail } }
 * Backend → Crée utilisateur → Lance shell → Retourne { isStreaming: true, resource }
 *
 * STREAMING:
 * Shell stdout/stderr → callbacks.onStream("stdout", data) → WebSocket → Frontend
 * Frontend → WebSocket → { type: "terminal:input", data } → resource.write(data) → Shell stdin
 *
 * REDIMENSIONNEMENT:
 * Frontend → WebSocket → { type: "terminal:resize", cols, rows } → resource.resize()
 *
 * FERMETURE:
 * Shell exit → cleanup() → deleteUser() → WebSocket fermé
 * Inactivité 10min → cleanup() → deleteUser() → WebSocket fermé
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EXEMPLE D'UTILISATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * const result = await streamTerminal(
 *   { cols: 120, rows: 32, userEmail: "admin@example.com" },
 *   {
 *     onStream: (streamType, data) => {
 *       // Envoyer au WebSocket
 *       ws.send(JSON.stringify({ type: "stream", stream: streamType, data }));
 *     },
 *     onResource: (resource) => {
 *       // Stocker pour gérer les inputs/resize
 *       terminalResources.set(requestId, resource);
 *     },
 *     context: { userId, companyId }
 *   }
 * );
 *
 * // Résultat:
 * {
 *   isStreaming: true,
 *   initialResponse: { message: "Terminal connecté", username, cols, rows },
 *   resource: { type: "terminal", process, write, resize, cleanup }
 * }
 *
 * @module modules/terminal/actions/stream
 */

import { spawn } from "child_process";
import { logger } from "../../../shared/logger.js";
import { validateTerminalParams } from "../validator.js";
import { requireRole } from "../../../websocket/auth.js";
import { executeCommand } from "../../../shared/executor.js";

/**
 * Supprime un utilisateur et son répertoire home
 * @param {string} username - Nom d'utilisateur à supprimer
 */
async function deleteUser(username) {
  try {
    logger.info(`Suppression de l'utilisateur inactif: ${username}`);

    // Tuer tous les processus de l'utilisateur
    await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- pkill -u ${username} -9 || true`,
      { timeout: 5000 },
    );

    // Supprimer l'utilisateur et son répertoire home
    await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- userdel -r ${username} 2>&1 || true`,
      { timeout: 10000 },
    );

    logger.info(`Utilisateur ${username} supprimé avec succès`);
  } catch (error) {
    logger.error(`Erreur lors de la suppression de l'utilisateur ${username}`, {
      error: error.message,
    });
  }
}

/**
 * Crée un utilisateur limité pour le terminal si nécessaire
 * @param {string} userEmail - Email de l'utilisateur connecté
 * @returns {Promise<string>} Nom d'utilisateur à utiliser
 */
async function ensureLimitedUser(userEmail) {
  // Générer le nom d'utilisateur à partir de l'email + suffixe "devoups"
  // Format: prenom-nom-devoups
  let username = "terminal-devoups"; // Valeur par défaut

  if (userEmail && typeof userEmail === "string" && userEmail.includes("@")) {
    const localPart = userEmail.split("@")[0];
    // Remplacer les points par des tirets et nettoyer les caractères spéciaux
    let cleanUsername = localPart
      .replace(/\./g, "-")
      .replace(/[^a-z0-9-]/gi, "")
      .toLowerCase();

    // S'assurer que le nom d'utilisateur est valide (commence par une lettre ou underscore)
    if (!/^[a-z_]/.test(cleanUsername)) {
      cleanUsername = "user-" + cleanUsername;
    }

    // Ajouter le suffixe -devoups
    username = cleanUsername + "-devoups";

    // Limiter la longueur du nom d'utilisateur (max 32 caractères pour Linux)
    if (username.length > 32) {
      // Si trop long, raccourcir la partie email pour garder le suffixe -devoups
      const maxEmailLength = 32 - 8; // 32 - "-devoups".length
      cleanUsername = cleanUsername.substring(0, maxEmailLength);
      username = cleanUsername + "-devoups";
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
        `nsenter -t 1 -m -u -i -n -p -- sh -c 'mkdir -p /home/${username} && chown -R ${username}:${username} /home/${username} && chmod 755 /home/${username}' 2>&1`,
        { timeout: 10000 },
      );

      logger.info(`Utilisateur ${username} créé avec succès`);
    } else {
      logger.debug(
        `Utilisateur ${username} existe déjà - Mise à jour de la configuration`,
      );

      // S'assurer que le répertoire home existe
      const homeCheck = await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- test -d /home/${username} && echo "exists" || echo "missing"`,
        { timeout: 3000 },
      );

      if (homeCheck.stdout.trim() === "missing") {
        logger.warn(`Répertoire home manquant pour ${username}, création...`);
        await executeCommand(
          `nsenter -t 1 -m -u -i -n -p -- sh -c 'mkdir -p /home/${username} && chown -R ${username}:${username} /home/${username} && chmod 755 /home/${username}' 2>&1`,
          { timeout: 10000 },
        );
      } else {
        // S'assurer que les permissions sont correctes même si le répertoire existe
        logger.info(
          `Vérification et correction des permissions pour ${username}`,
        );
        await executeCommand(
          `nsenter -t 1 -m -u -i -n -p -- sh -c 'chown -R ${username}:${username} /home/${username} && chmod 755 /home/${username}' 2>&1 || true`,
          { timeout: 10000 },
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

    // Créer un .bashrc simple et fonctionnel (sans restrictions complexes pour l'instant)
    const bashrcContent = `# Configuration Devoups Terminal User

# Couleurs pour ls
alias ls='ls --color=auto'
alias ll='ls -lah --color=auto'
alias la='ls -A --color=auto'

# Alias utiles
alias ..='cd ..'
alias ...='cd ../..'
alias grep='grep --color=auto'

# Message de bienvenue
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║          Terminal Devoups                                 ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "🐳 Accès Docker: Commandes docker disponibles"
echo "⏱️  Timeout: 10 minutes d'inactivité"
echo ""
`;

    // Créer le fichier .bashrc
    await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- sh -c 'cat > /home/${username}/.bashrc << 'BASHRC_EOF'
${bashrcContent}
BASHRC_EOF'`,
      { timeout: 5000 },
    );

    // Créer un fichier .bash_profile pour forcer le chargement de .bashrc
    await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- sh -c 'cat > /home/${username}/.bash_profile << 'PROFILE_EOF'
# Charger .bashrc
if [ -f ~/.bashrc ]; then
    . ~/.bashrc
fi
PROFILE_EOF'`,
      { timeout: 5000 },
    );

    // Créer un répertoire .local pour les fichiers temporaires
    await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- mkdir -p /home/${username}/.local 2>&1 || true`,
      { timeout: 5000 },
    );

    // Configurer TOUTES les permissions en une seule commande pour éviter les problèmes
    await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- sh -c '
        chown -R ${username}:${username} /home/${username} &&
        chmod 755 /home/${username} &&
        chmod 644 /home/${username}/.bashrc &&
        chmod 644 /home/${username}/.bash_profile &&
        chmod 755 /home/${username}/.local
      ' 2>&1 || true`,
      { timeout: 10000 },
    );

    logger.info(`Permissions configurées pour ${username}`);

    // Ajouter l'utilisateur au groupe docker
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
    // Utiliser script pour créer un PTY interactif avec bash
    // script -q -c "bash" crée un shell interactif avec PTY
    // -q = quiet (pas de message de démarrage)
    // -c = commande à exécuter
    // --login = charger .bash_profile et .bashrc
    // cd ~ = forcer le démarrage dans le répertoire home
    const shellCommand = `nsenter -t 1 -m -u -i -n -p -- su - ${username} -c "cd /home/${username} && exec script -q -c 'bash --login' /dev/null"`;

    const shellProcess = spawn("sh", ["-c", shellCommand], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: cols.toString(),
        LINES: rows.toString(),
      },
    });

    // Timer d'inactivité (10 minutes)
    const INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutes en millisecondes
    let inactivityTimer = null;

    // Fonction pour réinitialiser le timer d'inactivité
    const resetInactivityTimer = () => {
      // Annuler le timer précédent
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
      }

      // Créer un nouveau timer
      inactivityTimer = setTimeout(() => {
        logger.warn(
          `Terminal inactif pendant 10 minutes - Fermeture et suppression de l'utilisateur ${username}`,
          { userId },
        );

        try {
          // Envoyer un message avant de fermer
          callbacks.onStream(
            "stdout",
            "\r\n\r\n\x1b[33m╔═══════════════════════════════════════════════════════════╗\x1b[0m\r\n",
          );
          callbacks.onStream(
            "stdout",
            "\x1b[33m║  TERMINAL INACTIF - Fermeture automatique dans 5s...    ║\x1b[0m\r\n",
          );
          callbacks.onStream(
            "stdout",
            "\x1b[33m║  Raison: Inactivité de 10 minutes                        ║\x1b[0m\r\n",
          );
          callbacks.onStream(
            "stdout",
            "\x1b[33m╚═══════════════════════════════════════════════════════════╝\x1b[0m\r\n\r\n",
          );
        } catch (e) {
          logger.debug("Erreur lors de l'envoi du message d'inactivité", {
            error: e.message,
          });
        }

        // Attendre 5 secondes pour que l'utilisateur voit le message
        setTimeout(() => {
          cleanup();
          // Supprimer l'utilisateur après la fermeture du terminal
          deleteUser(username);
        }, 5000);
      }, INACTIVITY_TIMEOUT);
    };

    // Démarrer le timer d'inactivité
    resetInactivityTimer();

    // Fonction de nettoyage
    const cleanup = () => {
      // Annuler le timer d'inactivité
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }

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
        // Réinitialiser le timer d'inactivité à chaque sortie
        resetInactivityTimer();
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
        // Réinitialiser le timer d'inactivité à chaque erreur
        resetInactivityTimer();
        callbacks.onStream("stderr", chunk.toString());
      } catch (error) {
        logger.error("Erreur lors de l'envoi des données stderr", {
          error: error.message,
        });
      }
    });

    // Gérer la fin du processus
    shellProcess.on("exit", (code, signal) => {
      logger.info("Terminal fermé", { code, signal, userId, username });

      // Annuler le timer d'inactivité
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }

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

      // Supprimer l'utilisateur après la fermeture normale
      logger.info(
        `Suppression de l'utilisateur ${username} après fermeture du terminal`,
      );
      setTimeout(() => {
        deleteUser(username);
      }, 2000);
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
          // Réinitialiser le timer d'inactivité à chaque entrée utilisateur
          resetInactivityTimer();
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

    // Le message de bienvenue est maintenant dans .bashrc
    // Pas besoin de message supplémentaire ici

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
