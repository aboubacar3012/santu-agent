/**
 * Module Docker - Point d'entrée principal.
 *
 * Exporte toutes les fonctionnalités du module Docker de manière centralisée.
 *
 * @module modules/docker/index
 */

import { listContainers } from "./actions/list.js";
import { inspectContainer } from "./actions/inspect.js";
import { startContainer } from "./actions/start.js";
import { stopContainer } from "./actions/stop.js";
import { restartContainer } from "./actions/restart.js";
import { getContainerLogs } from "./actions/logs.js";
import { getContainerStats } from "./actions/stats.js";
import { execContainer } from "./actions/exec.js";
import * as validator from "./validator.js";

// Mapping des noms d'actions vers les fonctions
const actions = {
  list: listContainers,
  inspect: inspectContainer,
  start: startContainer,
  stop: stopContainer,
  restart: restartContainer,
  logs: getContainerLogs,
  stats: getContainerStats,
  exec: execContainer,
};

export { actions, validator };
