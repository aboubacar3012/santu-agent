/**
 * Module UFW - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module UFW de manière centralisée.
 *
 * @module modules/ufw/index
 */

import { listUfwRules } from "./actions/list.js";
import { applyUfwRules } from "./actions/apply.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  list: listUfwRules,
  apply: applyUfwRules,
};

export { actions, validator };

