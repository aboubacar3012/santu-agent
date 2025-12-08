/**
 * Module Activity - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module Activity de manière centralisée.
 *
 * @module modules/activity/index
 */

import { streamActivity } from "./actions/stream.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  stream: streamActivity,
};

export { actions, validator };
