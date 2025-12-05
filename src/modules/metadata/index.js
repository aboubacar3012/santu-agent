/**
 * Module Metadata - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module Metadata de manière centralisée.
 *
 * @module modules/metadata/index
 */

import { getMetadata } from "./actions/info.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  info: getMetadata,
};

export { actions, validator };

