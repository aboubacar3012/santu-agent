/**
 * Module Backup - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module Backup de manière centralisée.
 *
 * @module modules/backup/index
 */

import { toggleLogsBackup } from "./actions/toggle-logs-backup.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  "toggle-logs-backup": toggleLogsBackup,
};

export { actions, validator };
