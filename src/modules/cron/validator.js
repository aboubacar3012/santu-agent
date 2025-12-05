/**
 * Validation des actions Cron.
 *
 * Ce module concentre toutes les règles de validation applicables aux actions
 * Cron afin d'éviter la duplication de logique dans les handlers.
 *
 * @module modules/cron/validator
 */

/**
 * Liste blanche des actions Cron autorisées
 */
const ALLOWED_CRON_ACTIONS = ["list", "add-cron"];

/**
 * Valide qu'une action Cron est autorisée
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidCronAction(action) {
  return ALLOWED_CRON_ACTIONS.includes(action);
}

/**
 * Interface standardisée pour le validator
 * @param {string} action - Action à valider
 * @returns {boolean} True si autorisée
 */
export function isValidAction(action) {
  return isValidCronAction(action);
}

/**
 * Valide les paramètres d'une action Cron
 * @param {string} action - Action Cron
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateCronParams(action, params) {
  return validateParams(action, params);
}

/**
 * Valide un champ de schedule cron
 * @param {string} field - Nom du champ
 * @param {string} value - Valeur à valider
 * @param {number} min - Valeur minimale
 * @param {number} max - Valeur maximale
 * @returns {boolean} True si valide
 */
function validateCronField(field, value, min, max) {
  if (value === "*") {
    return true;
  }

  // Vérifier les formats avec / (ex: */5, 0-59/5)
  if (value.includes("/")) {
    const parts = value.split("/");
    if (parts.length !== 2) {
      return false;
    }
    const base = parts[0];
    const step = parts[1];
    if (!/^\d+$/.test(step) || Number.parseInt(step, 10) < 1) {
      return false;
    }
    if (base === "*") {
      return true;
    }
    // Vérifier les plages (ex: 0-59/5)
    if (base.includes("-")) {
      const rangeParts = base.split("-");
      if (rangeParts.length !== 2) {
        return false;
      }
      const rangeMin = Number.parseInt(rangeParts[0], 10);
      const rangeMax = Number.parseInt(rangeParts[1], 10);
      return (
        !Number.isNaN(rangeMin) &&
        !Number.isNaN(rangeMax) &&
        rangeMin >= min &&
        rangeMax <= max &&
        rangeMin <= rangeMax
      );
    }
    // Si c'est juste un nombre avec /
    const num = Number.parseInt(base, 10);
    return !Number.isNaN(num) && num >= min && num <= max;
  }

  // Vérifier les plages (ex: 0-59)
  if (value.includes("-")) {
    const parts = value.split("-");
    if (parts.length !== 2) {
      return false;
    }
    const minVal = Number.parseInt(parts[0], 10);
    const maxVal = Number.parseInt(parts[1], 10);
    return (
      !Number.isNaN(minVal) &&
      !Number.isNaN(maxVal) &&
      minVal >= min &&
      maxVal <= max &&
      minVal <= maxVal
    );
  }

  // Vérifier les listes (ex: 1,3,5)
  if (value.includes(",")) {
    const parts = value.split(",");
    return parts.every((part) => {
      const num = Number.parseInt(part.trim(), 10);
      return !Number.isNaN(num) && num >= min && num <= max;
    });
  }

  // Vérifier un nombre simple
  const num = Number.parseInt(value, 10);
  return !Number.isNaN(num) && num >= min && num <= max;
}

/**
 * Interface standardisée pour la validation des paramètres
 * @param {string} action - Action Cron
 * @param {Object} params - Paramètres
 * @returns {Object} Paramètres validés
 * @throws {Error} Si les paramètres sont invalides
 */
export function validateParams(action, params) {
  switch (action) {
    case "list":
      // Pour l'instant, pas de paramètres requis pour list
      return {};
    case "add-cron":
      if (!params || typeof params !== "object") {
        throw new Error("Les paramètres doivent être un objet");
      }

      // Validation task_name
      if (!params.task_name || typeof params.task_name !== "string") {
        throw new Error(
          "task_name est requis et doit être une chaîne de caractères"
        );
      }
      const trimmedTaskName = params.task_name.trim();
      if (!trimmedTaskName) {
        throw new Error("task_name ne peut pas être vide");
      }
      // Validation regex : lettres, chiffres, tirets, underscores, espaces
      const taskNameRegex = /^[a-zA-Z0-9\s_-]+$/;
      if (!taskNameRegex.test(trimmedTaskName)) {
        throw new Error(
          "task_name est invalide. Utilisez uniquement des lettres, chiffres, tirets, underscores et espaces."
        );
      }

      // Validation command
      if (!params.command || typeof params.command !== "string") {
        throw new Error(
          "command est requis et doit être une chaîne de caractères"
        );
      }
      const trimmedCommand = params.command.trim();
      if (!trimmedCommand) {
        throw new Error("command ne peut pas être vide");
      }

      // Validation schedule
      if (!params.schedule || typeof params.schedule !== "object") {
        throw new Error("schedule est requis et doit être un objet");
      }
      const { minute, hour, day, month, weekday } = params.schedule;

      if (!minute || typeof minute !== "string") {
        throw new Error("schedule.minute est requis et doit être une chaîne");
      }
      if (!validateCronField("minute", minute, 0, 59)) {
        throw new Error(
          "schedule.minute est invalide. Utilisez un nombre entre 0-59, *, ou un format cron valide."
        );
      }

      if (!hour || typeof hour !== "string") {
        throw new Error("schedule.hour est requis et doit être une chaîne");
      }
      if (!validateCronField("hour", hour, 0, 23)) {
        throw new Error(
          "schedule.hour est invalide. Utilisez un nombre entre 0-23, *, ou un format cron valide."
        );
      }

      if (!day || typeof day !== "string") {
        throw new Error("schedule.day est requis et doit être une chaîne");
      }
      if (!validateCronField("day", day, 1, 31)) {
        throw new Error(
          "schedule.day est invalide. Utilisez un nombre entre 1-31, *, ou un format cron valide."
        );
      }

      if (!month || typeof month !== "string") {
        throw new Error("schedule.month est requis et doit être une chaîne");
      }
      if (!validateCronField("month", month, 1, 12)) {
        throw new Error(
          "schedule.month est invalide. Utilisez un nombre entre 1-12, *, ou un format cron valide."
        );
      }

      if (!weekday || typeof weekday !== "string") {
        throw new Error("schedule.weekday est requis et doit être une chaîne");
      }
      if (!validateCronField("weekday", weekday, 0, 7)) {
        throw new Error(
          "schedule.weekday est invalide. Utilisez un nombre entre 0-7 (0 et 7 = dimanche), *, ou un format cron valide."
        );
      }

      // Validation user (défaut: "root")
      const user =
        params.user && typeof params.user === "string"
          ? params.user.trim()
          : "root";
      if (!user) {
        throw new Error("user ne peut pas être vide");
      }

      // Validation description (optionnel)
      const description =
        params.description && typeof params.description === "string"
          ? params.description.trim()
          : null;

      // Validation enabled (défaut: true)
      const enabled =
        params.enabled !== undefined ? Boolean(params.enabled) : true;

      return {
        task_name: trimmedTaskName,
        command: trimmedCommand,
        schedule: {
          minute: minute.trim(),
          hour: hour.trim(),
          day: day.trim(),
          month: month.trim(),
          weekday: weekday.trim(),
        },
        user,
        description,
        enabled,
      };
    default:
      return params;
  }
}
