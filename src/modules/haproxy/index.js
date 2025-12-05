/**
 * Module HAProxy - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module HAProxy de manière centralisée.
 *
 * @module modules/haproxy/index
 */

import { listHaproxyConfig } from "./actions/list.js";
import { addHaproxyApp } from "./actions/add-app.js";
import { listHaproxyApps } from "./actions/app-list.js";
import { removeHaproxyApp } from "./actions/remove-app.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  list: listHaproxyConfig,
  "add-app": addHaproxyApp,
  "app-list": listHaproxyApps,
  "remove-app": removeHaproxyApp,
};

export { actions, validator };
