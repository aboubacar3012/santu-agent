/**
 * Module Terminal - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module Terminal de manière centralisée.
 *
 * @module modules/terminal/index
 */

import { streamTerminal } from "./actions/stream.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  stream: streamTerminal,
};

export { actions, validator };
