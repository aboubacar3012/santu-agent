/**
 * Module SSH - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module SSH de manière centralisée.
 *
 * @module modules/ssh/index
 */

import { listSshKeys } from "./actions/list.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  list: listSshKeys,
};

export { actions, validator };
