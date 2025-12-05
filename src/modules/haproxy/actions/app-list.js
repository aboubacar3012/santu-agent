/**
 * Action app-list - Liste les applications HAProxy configurées
 *
 * @module modules/haproxy/actions/app-list
 */

import { logger } from "../../../shared/logger.js";
import { validateHaproxyParams } from "../validator.js";
import { executeHostCommand, hostFileExists } from "./utils.js";

/**
 * Liste les applications HAProxy configurées
 * @param {Object} params - Paramètres (non utilisés pour l'instant)
 * @param {Object} [callbacks] - Callbacks (non utilisés pour cette action)
 * @returns {Promise<Object>} Objet contenant un tableau d'applications
 */
export async function listHaproxyApps(params = {}, callbacks = {}) {
  try {
    validateHaproxyParams("app-list", params);

    logger.debug("Début de la récupération de la liste des applications HAProxy");

    const aclDir = "/etc/haproxy/conf.d/acls";
    const backendDir = "/etc/haproxy/conf.d/backends";
    const apps = [];

    // Vérifier si le répertoire ACL existe
    const checkDirResult = await executeHostCommand(
      `test -d '${aclDir}' && echo 'exists' || echo 'not_exists'`
    );
    if (checkDirResult.stdout.trim() !== "exists") {
      logger.debug("Le répertoire ACL n'existe pas");
      return { apps: [] };
    }

    // Lister les fichiers ACL
    const listAclFilesResult = await executeHostCommand(
      `ls -1 '${aclDir}'/*.cfg 2>/dev/null || echo ''`
    );

    const aclFiles = listAclFilesResult.stdout
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0);

    if (aclFiles.length === 0) {
      logger.debug("Aucun fichier ACL trouvé");
      return { apps: [] };
    }

    // Traiter chaque fichier ACL
    for (const aclPath of aclFiles) {
      try {
        // Extraire le slug (nom du fichier sans extension)
        const slugMatch = aclPath.match(/\/([^/]+)\.cfg$/);
        if (!slugMatch) {
          continue;
        }
        const slug = slugMatch[1];

        // Lire le contenu du fichier ACL
        const aclContentResult = await executeHostCommand(
          `cat '${aclPath}' 2>/dev/null || echo ''`
        );
        const aclContent = aclContentResult.stdout || "";

        // Extraire le domaine avec regex: -i\s+([^\s]+)
        const domainMatch = aclContent.match(/-i\s+([^\s]+)/);
        const domain = domainMatch ? domainMatch[1].trim() : "";

        // Lire le fichier backend correspondant
        const backendPath = `${backendDir}/${slug}.cfg`;
        const backendExists = await hostFileExists(backendPath);
        let backendHost = "";
        let backendPort = "";

        if (backendExists) {
          const backendContentResult = await executeHostCommand(
            `cat '${backendPath}' 2>/dev/null || echo ''`
          );
          const backendContent = backendContentResult.stdout || "";

          // Extraire le host et port avec regex: server\s+\S+\s+([^:\s]+):(\d+)
          const serverMatch = backendContent.match(
            /server\s+\S+\s+([^:\s]+):(\d+)/
          );
          if (serverMatch) {
            backendHost = serverMatch[1].trim();
            backendPort = serverMatch[2].trim();
          }
        }

        apps.push({
          slug,
          domain,
          backendHost,
          backendPort,
        });
      } catch (error) {
        logger.warn("Erreur lors du traitement d'un fichier ACL", {
          error: error.message,
          aclPath,
        });
        // Continuer avec le fichier suivant
        continue;
      }
    }

    logger.info("Liste des applications HAProxy récupérée avec succès", {
      count: apps.length,
    });

    return { apps };
  } catch (error) {
    logger.error("Erreur lors de la récupération de la liste des applications HAProxy", {
      error: error.message,
    });
    throw error;
  }
}

