/**
 * Action add-cron - Ajoute une tâche cron dans /etc/cron.d/
 *
 * @module modules/cron/actions/add-cron
 */

import { logger } from "../../../shared/logger.js";
import { validateCronParams } from "../validator.js";
import { executeHostCommand, hostFileExists } from "./utils.js";
import { requireRole } from "../../../websocket/auth.js";

/**
 * Génère un nom de fichier slug à partir d'un nom de tâche
 * Tous les fichiers cron personnalisés commencent par "agent-cron"
 * @param {string} taskName - Nom de la tâche
 * @returns {string} Nom de fichier slug avec préfixe "agent-cron"
 */
function generateFileName(taskName) {
  const slug = taskName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]/g, "") // Supprimer les caractères spéciaux
    .replace(/\s+/g, "-") // Remplacer les espaces par des tirets
    .replace(/-+/g, "-") // Remplacer les tirets multiples par un seul
    .replace(/^-+|-+$/g, ""); // Supprimer les tirets en début/fin

  // Ajouter le préfixe "agent-cron" si le slug n'est pas vide
  return slug ? `agent-cron-${slug}` : "";
}

/**
 * Ajoute une tâche cron dans /etc/cron.d/
 * @param {Object} params - Paramètres de la tâche cron
 * @param {string} params.task_name - Nom de la tâche
 * @param {string} params.command - Commande à exécuter
 * @param {Object} params.schedule - Planification (minute, hour, day, month, weekday)
 * @param {string} [params.user] - Utilisateur (défaut: "root")
 * @param {string} [params.description] - Description optionnelle
 * @param {boolean} [params.enabled] - Tâche active (défaut: true)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Résultat de l'opération
 */
export async function addCronJob(params = {}, callbacks = {}) {
  try {
    // Vérifier les permissions : seuls ADMIN et OWNER et EDITOR peuvent ajouter des tâches cron
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER", "EDITOR"],
      "ajouter une tâche cron",
    );

    // Valider les paramètres
    const validatedParams = validateCronParams("add-cron", params);
    const { task_name, command, schedule, user, description, enabled } =
      validatedParams;

    logger.debug("Début de l'ajout d'une tâche cron", {
      task_name,
      user,
      enabled,
    });

    const cronDir = "/etc/cron.d";
    const fileName = generateFileName(task_name);

    if (!fileName) {
      throw new Error(
        "Impossible de générer un nom de fichier valide à partir du nom de la tâche",
      );
    }

    const filePath = `${cronDir}/${fileName}`;

    // Vérifier si le fichier existe déjà
    const fileExists = await hostFileExists(filePath);
    if (fileExists) {
      logger.debug("Le fichier existe déjà, il sera écrasé", { filePath });
    }

    // S'assurer que le répertoire /etc/cron.d existe
    const mkdirResult = await executeHostCommand(
      `mkdir -p '${cronDir}' && chmod 755 '${cronDir}'`,
    );
    if (mkdirResult.error) {
      logger.warn("Erreur lors de la création du répertoire cron.d", {
        stderr: mkdirResult.stderr,
      });
    }

    // Construire le contenu du fichier
    let fileContent = "";

    // Ajouter la description en commentaire si fournie
    if (description) {
      fileContent += `# ${description}\n`;
    }

    // Construire la ligne cron
    // Format: minute hour day month weekday user command
    // Si enabled est false, commenter la ligne
    const cronLine = `${schedule.minute} ${schedule.hour} ${schedule.day} ${schedule.month} ${schedule.weekday} ${user} ${command}`;

    if (enabled) {
      fileContent += `${cronLine}\n`;
    } else {
      // Si désactivé, commenter la ligne
      fileContent += `# ${cronLine}\n`;
    }

    // Échapper le contenu pour l'utiliser dans une commande shell
    const escapedContent = fileContent
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "'\"'\"'")
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");

    // Créer ou écraser le fichier
    logger.debug(
      fileExists ? "Écrasement du fichier cron" : "Création du fichier cron",
      { filePath },
    );
    // Utiliser printf avec %s\n pour garantir la nouvelle ligne à la fin
    // Les fichiers /etc/cron.d/ DOIVENT se terminer par une nouvelle ligne
    const writeResult = await executeHostCommand(
      `printf '%s\\n' '${escapedContent.trim()}' > '${filePath}' && chmod 644 '${filePath}' && chown root:root '${filePath}'`,
    );

    if (writeResult.error) {
      throw new Error(
        `Erreur lors de la création du fichier cron: ${writeResult.stderr}`,
      );
    }

    logger.info(
      fileExists
        ? "Tâche cron mise à jour avec succès"
        : "Tâche cron créée avec succès",
      {
        task_name,
        filePath,
        enabled,
      },
    );

    return {
      success: true,
      task_name,
      file_path: filePath,
      enabled,
      message: fileExists
        ? `Tâche cron "${task_name}" mise à jour avec succès dans ${filePath}`
        : `Tâche cron "${task_name}" créée avec succès dans ${filePath}`,
    };
  } catch (error) {
    logger.error("Erreur lors de l'ajout de la tâche cron", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}
