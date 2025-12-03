/**
 * Module SSH - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module SSH de manière centralisée.
 *
 * @module modules/ssh/index
 */

import * as actionsModule from "./actions.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  list: actionsModule.listSshKeys,
};

export { actions, validator };
