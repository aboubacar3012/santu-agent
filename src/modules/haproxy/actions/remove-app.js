/**
 * Action remove-app - Supprime une application HAProxy
 *
 * @module modules/haproxy/actions/remove-app
 */

import { logger } from "../../../shared/logger.js";
import { validateHaproxyParams } from "../validator.js";
import { executeHostCommand, hostFileExists } from "./utils.js";
import { requireRole } from "../../../websocket/auth.js";

/**
 * Supprime une application HAProxy
 * @param {Object} params - Paramètres de l'application
 * @param {string} params.app_slug - Slug de l'application à supprimer
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Résultat de l'opération
 */
export async function removeHaproxyApp(params = {}, callbacks = {}) {
  try {
    // Vérifier les permissions : ADMIN, OWNER et EDITOR peuvent supprimer une application HAProxy
    const userId = callbacks?.context?.userId;
    const companyId = callbacks?.context?.companyId;

    await requireRole(
      userId,
      companyId,
      ["ADMIN", "OWNER"],
      "supprimer une application HAProxy"
    );

    // Valider les paramètres
    const validatedParams = validateHaproxyParams("remove-app", params);
    const { app_slug } = validatedParams;

    logger.debug("Début de la suppression d'une application HAProxy", {
      app_slug,
    });

    const haproxy_acl_dir = "/etc/haproxy/conf.d/acls";
    const haproxy_backend_dir = "/etc/haproxy/conf.d/backends";
    const haproxy_service_name = "haproxy";

    // 1. Vérifier l'état initial de HAProxy
    logger.debug("Vérification de l'état de HAProxy");
    const haproxyStateResult = await executeHostCommand(
      `systemctl is-active ${haproxy_service_name} || echo 'inactive'`
    );
    const haproxyInitialState = haproxyStateResult.stdout.trim();
    const isHaproxyActive = haproxyInitialState === "active";
    logger.debug("État initial de HAProxy", { state: haproxyInitialState });

    // 2. Supprimer le fichier ACL
    const aclPath = `${haproxy_acl_dir}/${app_slug}.cfg`;
    const aclExists = await hostFileExists(aclPath);
    let aclRemoved = false;

    if (aclExists) {
      logger.debug("Suppression du fichier ACL", { path: aclPath });
      const aclDeleteResult = await executeHostCommand(`rm -f '${aclPath}'`);
      if (aclDeleteResult.error) {
        logger.warn("Erreur lors de la suppression du fichier ACL", {
          error: aclDeleteResult.stderr,
        });
      } else {
        aclRemoved = true;
        logger.debug("Fichier ACL supprimé avec succès");
      }
    } else {
      logger.debug(
        "Le fichier ACL n'existe pas, aucune suppression nécessaire"
      );
    }

    // 3. Supprimer le fichier backend
    const backendPath = `${haproxy_backend_dir}/${app_slug}.cfg`;
    const backendExists = await hostFileExists(backendPath);
    let backendRemoved = false;

    if (backendExists) {
      logger.debug("Suppression du fichier backend", { path: backendPath });
      const backendDeleteResult = await executeHostCommand(
        `rm -f '${backendPath}'`
      );
      if (backendDeleteResult.error) {
        logger.warn("Erreur lors de la suppression du fichier backend", {
          error: backendDeleteResult.stderr,
        });
      } else {
        backendRemoved = true;
        logger.debug("Fichier backend supprimé avec succès");
      }
    } else {
      logger.debug(
        "Le fichier backend n'existe pas, aucune suppression nécessaire"
      );
    }

    // 4. Supprimer l'ancien fichier legacy
    const legacyPath = `/etc/haproxy/conf.d/apps/${app_slug}.cfg`;
    const legacyExists = await hostFileExists(legacyPath);
    let legacyRemoved = false;

    if (legacyExists) {
      logger.debug("Suppression de l'ancien fichier legacy", {
        path: legacyPath,
      });
      const legacyDeleteResult = await executeHostCommand(
        `rm -f '${legacyPath}'`
      );
      if (legacyDeleteResult.error) {
        logger.warn("Erreur lors de la suppression du fichier legacy", {
          error: legacyDeleteResult.stderr,
        });
      } else {
        legacyRemoved = true;
        logger.debug("Fichier legacy supprimé avec succès");
      }
    } else {
      logger.debug(
        "Le fichier legacy n'existe pas, aucune suppression nécessaire"
      );
    }

    // Vérifier si des fichiers ont été supprimés
    const filesWereRemoved = aclRemoved || backendRemoved || legacyRemoved;

    if (!filesWereRemoved) {
      logger.info("Aucun fichier à supprimer pour cette application", {
        app_slug,
      });
      return {
        success: true,
        app_slug,
        message: `Aucun fichier trouvé pour l'application ${app_slug}`,
        files_removed: {
          acl: false,
          backend: false,
          legacy: false,
        },
      };
    }

    logger.info("Application HAProxy supprimée avec succès", {
      app_slug,
      files_removed: {
        acl: aclRemoved,
        backend: backendRemoved,
        legacy: legacyRemoved,
      },
    });

    return {
      success: true,
      app_slug,
      message: `Application ${app_slug} supprimée avec succès`,
      files_removed: {
        acl: aclRemoved,
        backend: backendRemoved,
        legacy: legacyRemoved,
      },
    };
  } catch (error) {
    logger.error("Erreur lors de la suppression de l'application HAProxy", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}
