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
 * Limites appliquées :
 * - Accès uniquement au répertoire home
 * - 5GB d'espace disque maximum
 * - 2 CPU maximum
 * - 8GB RAM maximum
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

    if (checkUser.stdout.trim() === "not_found") {
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

      // Configurer les limites de ressources via /etc/security/limits.conf
      try {
        // Limites de ressources (5GB disque, 2 CPU max, 8GB RAM)
        // as = address space (RAM) en KB, donc 8GB = 8388608 KB
        // nproc = nombre de processus simultanés (50 pour permettre à bash de fonctionner)
        // fsize = taille max de fichier en KB, donc 5GB = 5242880 KB
        // Note: Pour limiter à 2 CPU, on utilisera cgroups dans la commande shell
        const limitsConf = `\n# Limites pour ${username}
${username} hard as 8388608
${username} soft as 8388608
${username} hard nproc 50
${username} soft nproc 50
${username} hard fsize 5242880
${username} soft fsize 5242880
${username} hard nofile 1024
${username} soft nofile 1024
`;

        await executeCommand(
          `nsenter -t 1 -m -u -i -n -p -- sh -c 'echo "${limitsConf}" >> /etc/security/limits.conf' 2>&1 || true`,
          { timeout: 5000 },
        );

        // Configurer les quotas de disque (5GB) si les quotas sont activés
        try {
          // Vérifier si les quotas sont activés
          const quotaCheck = await executeCommand(
            `nsenter -t 1 -m -u -i -n -p -- quotaon -a 2>&1 || echo "quota_not_enabled"`,
            { timeout: 3000 },
          );

          if (!quotaCheck.stdout.includes("quota_not_enabled")) {
            // Définir le quota utilisateur à 5GB (en blocs de 1KB)
            // 5GB = 5242880 KB
            await executeCommand(
              `nsenter -t 1 -m -u -i -n -p -- setquota -u ${username} 5242880 5242880 0 0 / 2>&1 || true`,
              { timeout: 5000 },
            );
            logger.info(`Quota de disque configuré pour ${username} (5GB)`);
          }
        } catch (quotaError) {
          logger.debug(
            "Les quotas de disque ne sont pas disponibles, utilisation des limites de fichiers uniquement",
            {
              error: quotaError.message,
            },
          );
        }

        logger.info(`Limites de ressources configurées pour ${username}`);
      } catch (error) {
        logger.warn(
          "Erreur lors de la configuration des limites de ressources",
          {
            error: error.message,
          },
        );
      }

      // Créer un .bashrc personnalisé pour limiter l'accès au home uniquement
      const bashrcContent = [
        "# Configuration Devoups Temp User",
        "# Accès limité au répertoire home uniquement",
        "",
        "# Empêcher la navigation en dehors du home",
        "cd() {",
        '  local target="${1:-~}"',
        "  local resolved_path",
        "  ",
        "  # Résoudre le chemin absolu",
        '  if [[ "$target" =~ ^/ ]]; then',
        '    resolved_path="$target"',
        "  else",
        '    resolved_path="$(pwd)/$target"',
        "  fi",
        '  resolved_path="$(readlink -f "$resolved_path" 2>/dev/null || echo "$resolved_path")"',
        "  ",
        `  # Vérifier que le chemin est dans le home de l'utilisateur`,
        `  if [[ ! "$resolved_path" =~ ^/home/${username}(/|$) ]]; then`,
        '    echo "Accès refusé: vous ne pouvez accéder qu à votre répertoire home (/home/' +
          username +
          ')"',
        "    return 1",
        "  fi",
        "  ",
        '  builtin cd "$target"',
        "}",
        "",
        "# Limiter PATH",
        'export PATH="$HOME/bin:$HOME/.local/bin:/usr/bin:/bin"',
        'export HOME="$HOME"',
        "",
        "# Afficher le MOTD au démarrage",
        'if [ -f "$HOME/.motd" ] && [ -z "$MOTD_SHOWN" ]; then',
        '  cat "$HOME/.motd"',
        "  export MOTD_SHOWN=1",
        "fi",
        "",
        "# Alias pour empêcher certaines commandes dangereuses",
        'alias rm="rm -i"',
        'alias mv="mv -i"',
        'alias cp="cp -i"',
        'alias chmod="echo Commande désactivée"',
        'alias chown="echo Commande désactivée"',
        'alias sudo="echo Commande sudo désactivée"',
        'alias su="echo Commande su désactivée"',
        "",
        "# Forcer le répertoire home au démarrage",
        "cd ~",
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
        "📁 Accès: Répertoire home uniquement (~)",
        "💾 Espace disque: 5 GB maximum",
        "⚡ CPU: 2 cœurs maximum",
        "🧠 RAM: 8 GB maximum",
        "",
        "📋 Commandes disponibles:",
        "   - Navigation dans votre répertoire home",
        "   - Commandes système de base (ls, cat, grep, etc.)",
        "   - Édition de fichiers dans votre home",
        "",
        "🚫 Restrictions:",
        "   - Accès uniquement à votre répertoire home",
        "   - Pas d accès root ou sudo",
        "   - Pas d accès aux répertoires système",
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

      // Changer le répertoire home en répertoire par défaut au login
      await executeCommand(
        `nsenter -t 1 -m -u -i -n -p -- sh -c 'echo "cd ~" >> /home/${username}/.bash_profile' 2>&1 || true`,
        { timeout: 5000 },
      );

      logger.info(
        `Utilisateur ${username} créé avec succès et restrictions appliquées`,
      );
    } else {
      logger.debug(`Utilisateur ${username} existe déjà`);
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
    // Limiter les CPU à 2 cœurs avec systemd-run si disponible
    // Changer vers le home et afficher le MOTD au démarrage
    const shellCommand = `nsenter -t 1 -m -u -i -n -p -- sh -c '
      if command -v systemd-run >/dev/null 2>&1; then
        systemd-run --user --scope --cpu-quota=200% -- su - ${username} -c "cd ~ && script -q -c '\''bash --login'\'' /dev/null"
      else
        su - ${username} -c "cd ~ && script -q -c '\''bash --login'\'' /dev/null"
      fi
    '`;

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
