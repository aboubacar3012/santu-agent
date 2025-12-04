/**
 * Module UFW - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module UFW de manière centralisée.
 *
 * @module modules/ufw/index
 */

import * as actionsModule from "./actions.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  list: actionsModule.listUfwRules,
  apply: actionsModule.applyUfwRules,
};

export { actions, validator };

