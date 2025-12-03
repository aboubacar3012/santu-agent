/**
 * Module Cron - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module Cron de manière centralisée.
 *
 * @module modules/cron/index
 */

import * as actionsModule from "./actions.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  list: actionsModule.listCronJobs,
};

export { actions, validator };
