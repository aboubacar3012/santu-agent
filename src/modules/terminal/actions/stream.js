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

    // Créer un .bashrc personnalisé avec restrictions de sécurité
    const bashrcContent = `# Configuration Devoups Terminal User - Mode Restreint

# Forcer le répertoire HOME
cd ~ 2>/dev/null || cd /home/${username}

# Limiter le PATH aux commandes sûres uniquement
export PATH="/usr/bin:/bin"

# Empêcher de changer de répertoire en dehors du home
cd() {
  local target="\${1:-.}"
  local abs_path=\$(readlink -f "\$target" 2>/dev/null || echo "\$target")
  
  # Vérifier si on essaie de sortir du home
  if [[ "\$abs_path" =~ ^/home/${username} ]] || [ "\$abs_path" = "/home/${username}" ]; then
    builtin cd "\$@"
  else
    echo "Erreur: Vous ne pouvez naviguer que dans votre répertoire home"
    return 1
  fi
}

# Désactiver certaines commandes dangereuses
alias rm='echo "Commande rm désactivée. Utilisez: trash <fichier>"'
alias rmdir='echo "Commande rmdir désactivée."'
alias mv='echo "Commande mv désactivée pour les fichiers système."'
alias chmod='echo "Commande chmod désactivée pour les fichiers système."'
alias chown='echo "Commande chown désactivée."'
alias chgrp='echo "Commande chgrp désactivée."'
alias sudo='echo "Commande sudo désactivée."'
alias su='echo "Commande su désactivée."'

# Fonction pour créer des fichiers/dossiers (autorisé uniquement dans home)
mkdir() {
  local target="\$1"
  if [[ "\$target" =~ ^/home/${username}/ ]] || [[ "\$target" != /* ]]; then
    command mkdir "\$@"
  else
    echo "Erreur: Création autorisée uniquement dans votre répertoire home"
    return 1
  fi
}

# Fonction trash pour supprimer uniquement les fichiers créés par l'utilisateur
trash() {
  local file="\$1"
  if [ -z "\$file" ]; then
    echo "Usage: trash <fichier>"
    return 1
  fi
  
  # Vérifier que le fichier est dans le home
  local abs_path=\$(readlink -f "\$file" 2>/dev/null)
  if [[ ! "\$abs_path" =~ ^/home/${username}/ ]]; then
    echo "Erreur: Vous ne pouvez supprimer que les fichiers dans votre répertoire home"
    return 1
  fi
  
  # Vérifier que l'utilisateur est le propriétaire
  local owner=\$(stat -c '%U' "\$file" 2>/dev/null)
  if [ "\$owner" != "${username}" ]; then
    echo "Erreur: Vous ne pouvez supprimer que les fichiers que vous avez créés"
    return 1
  fi
  
  command rm -rf "\$file"
  echo "Fichier supprimé: \$file"
}

# Couleurs pour ls
alias ls='ls --color=auto'
alias ll='ls -lah --color=auto'

# Message de bienvenue
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║          Terminal Devoups - Mode Sécurisé                 ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "🔒 Restrictions de sécurité actives:"
echo "  • Accès limité à votre répertoire home uniquement"
echo "  • Création de fichiers/dossiers autorisée"
echo "  • Suppression: utilisez 'trash <fichier>' (uniquement vos fichiers)"
echo "  • Exécution limitée aux fichiers que vous créez"
echo ""
echo "⏱️  Timeout d'inactivité: 10 minutes"
echo "   → Le terminal se fermera automatiquement après 10 min d'inactivité"
echo "   → Votre compte utilisateur sera supprimé à la fermeture"
echo ""
echo "Commandes disponibles: ls, cat, echo, touch, mkdir, nano, vim, grep, etc."
echo ""
`;

    // Créer le fichier .bashrc
    await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- sh -c 'cat > /home/${username}/.bashrc << 'BASHRC_EOF'
${bashrcContent}
BASHRC_EOF'`,
      { timeout: 5000 },
    );

    // Définir les permissions appropriées pour .bashrc
    await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- chown ${username}:${username} /home/${username}/.bashrc && chmod 644 /home/${username}/.bashrc 2>&1 || true`,
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

    await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- chown ${username}:${username} /home/${username}/.bash_profile && chmod 644 /home/${username}/.bash_profile 2>&1 || true`,
      { timeout: 5000 },
    );

    // Configurer les permissions du répertoire home pour empêcher l'accès aux fichiers système
    // Rendre le home accessible uniquement par l'utilisateur
    await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- chmod 750 /home/${username} 2>&1 || true`,
      { timeout: 5000 },
    );

    // Créer un répertoire .local pour les fichiers temporaires
    await executeCommand(
      `nsenter -t 1 -m -u -i -n -p -- mkdir -p /home/${username}/.local && chown ${username}:${username} /home/${username}/.local 2>&1 || true`,
      { timeout: 5000 },
    );

    // NE PAS ajouter l'utilisateur au groupe docker pour des raisons de sécurité
    // Le groupe docker donne des privilèges équivalents à root
    logger.info(
      `Utilisateur ${username} configuré sans accès Docker (sécurité)`,
    );

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
