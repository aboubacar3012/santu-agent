/**
 * Validator pour le module Packages.
 *
 * Ce validator suit la même structure que les autres modules afin
 * d'assurer l'homogénéité de l'agent.
 */

const ALLOWED_PACKAGES_ACTIONS = ["list"];

export function isValidPackagesAction(action) {
  return ALLOWED_PACKAGES_ACTIONS.includes(action);
}

export function isValidAction(action) {
  return isValidPackagesAction(action);
}

export function validatePackagesParams(action, params) {
  return validateParams(action, params);
}

export function validateParams(action, params) {
  switch (action) {
    case "list":
      return {};
    default:
      return params;
  }
}
