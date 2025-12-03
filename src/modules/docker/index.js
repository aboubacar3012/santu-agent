/**
 * Module Docker - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module Docker de manière centralisée.
 *
 * @module modules/docker/index
 */

import * as actionsModule from "./actions.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  list: actionsModule.listContainers,
  inspect: actionsModule.inspectContainer,
  start: actionsModule.startContainer,
  stop: actionsModule.stopContainer,
  restart: actionsModule.restartContainer,
  logs: actionsModule.getContainerLogs,
  stats: actionsModule.getContainerStats,
  exec: actionsModule.execContainer,
};

export { actions, validator };
