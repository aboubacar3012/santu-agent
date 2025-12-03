/**
 * Module User - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module User de manière centralisée.
 *
 * @module modules/user/index
 */

import * as actionsModule from "./actions.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  list: actionsModule.listUsers,
};

export { actions, validator };

