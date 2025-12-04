/**
 * Module HAProxy - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module HAProxy de manière centralisée.
 *
 * @module modules/haproxy/index
 */

import * as actionsModule from "./actions.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  list: actionsModule.listHaproxyConfig,
};

export { actions, validator };
