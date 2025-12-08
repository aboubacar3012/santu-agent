/**
 * Module Metrics - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module Metrics de manière centralisée.
 *
 * @module modules/metrics/index
 */

import { streamMetrics } from "./actions/stream.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  stream: streamMetrics,
};

export { actions, validator };

