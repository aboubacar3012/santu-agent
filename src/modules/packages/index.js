/**
 * Module Packages - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module Packages de manière centralisée.
 *
 * @module modules/packages/index
 */

import { listPackages } from "./actions/list.js";
import * as validator from "./validator.js";

const actions = {
  list: listPackages,
};

export { actions, validator };

