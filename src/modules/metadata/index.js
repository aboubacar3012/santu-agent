/**
 * Module Metadata - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module Metadata de manière centralisée.
 *
 * @module modules/metadata/index
 */

import * as actionsModule from "./actions.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  info: actionsModule.getMetadata,
};

export { actions, validator };

