/**
 * Module User - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module User de manière centralisée.
 *
 * @module modules/user/index
 */

import { listUsers } from "./actions/list.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  list: listUsers,
};

export { actions, validator };

