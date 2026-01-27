#!/usr/bin/env python3
"""
###############################################################################
# SERVICE: Nettoyage des anciens logs Docker sur AWS S3
#
# DESCRIPTION:
# Ce script supprime automatiquement les logs Docker stockés sur S3 qui
# datent de plus de X jours (par défaut 45 jours).
#
# FONCTIONNEMENT:
# 1. Se connecte au bucket S3 configuré via les variables d'environnement AWS
# 2. Liste tous les fichiers de logs du serveur (hostname)
# 3. Compare la date de dernière modification avec la date limite
# 4. Supprime les fichiers trop anciens
# 5. Affiche un résumé (nombre de fichiers supprimés, espace libéré)
#
# STRUCTURE S3 CIBLÉE:
# s3://elyamaje-log-files/hostname/
# ├── container1/
# │   └── 2025-01-01/
# │       ├── 10h00min_all.log.gz
# │       └── 10h00min_errors.log.gz
# └── container2/
#     └── 2025-01-01/
#         ├── 10h00min_all.log.gz
#         └── 10h00min_errors.log.gz
#
# VARIABLES D'ENVIRONNEMENT REQUISES:
# - AWS_ACCESS_KEY_ID: Clé d'accès AWS
# - AWS_SECRET_ACCESS_KEY: Clé secrète AWS
# - AWS_REGION: Région AWS (ex: eu-west-3)
# - AWS_LOGS_BUCKET: Nom du bucket S3 (ex: elyamaje-log-files)
#
# USAGE:
# - Exécution manuelle: python3 docker_log_s3_cleanup.py
# - Avec durée personnalisée: python3 docker_log_s3_cleanup.py --days 30
# - Via cron: 0 4 * * * (tous les jours à 4h du matin)
# - Logs: /var/log/docker-log-s3-cleanup.log
#
# DÉPENDANCES:
# - boto3>=1.26.0
# - botocore>=1.29.0
# - pytz>=2023.3
#
# SORTIE:
# - Logs supprimés sur S3
# - Résumé détaillé dans /var/log/docker-log-s3-cleanup.log
###############################################################################
"""

import os
import sys
import logging
import socket
import argparse
import boto3
import pytz
from datetime import datetime, timedelta
from botocore.exceptions import ClientError, NoCredentialsError

# Configuration du logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)


def cleanup_old_s3_logs(days=45):
    """
    Supprime les logs sur S3 qui datent de plus de X jours.
    
    Args:
        days (int): Nombre de jours avant suppression (défaut: 45)
    
    Returns:
        dict: Résumé de l'opération (fichiers supprimés, espace libéré)
    """
    try:
        logger.info(f"═══════════════════════════════════════════════════════════")
        logger.info(f"Début du nettoyage S3 des logs de plus de {days} jours")
        logger.info(f"═══════════════════════════════════════════════════════════")
        
        # Vérifier les variables d'environnement
        bucket_name = os.environ.get("AWS_LOGS_BUCKET")
        if not bucket_name:
            logger.error("❌ Variable AWS_LOGS_BUCKET non définie")
            return {"success": False, "error": "AWS_LOGS_BUCKET manquant"}
        
        # Calculer la date limite (maintenant - X jours)
        paris_tz = pytz.timezone("Europe/Paris")
        current_time = datetime.now(paris_tz)
        cutoff_date = current_time - timedelta(days=days)
        
        logger.info(f"📅 Date actuelle: {current_time.strftime('%Y-%m-%d %H:%M:%S %Z')}")
        logger.info(f"📅 Date limite: {cutoff_date.strftime('%Y-%m-%d %H:%M:%S %Z')}")
        logger.info(f"🗑️  Suppression des fichiers modifiés avant le {cutoff_date.strftime('%Y-%m-%d')}")
        logger.info("")
        
        # Initialiser le client S3
        s3_client = boto3.client("s3")
        
        # Récupérer le hostname du serveur
        hostname = socket.gethostname()
        prefix = f"{hostname}/"
        
        logger.info(f"🖥️  Serveur: {hostname}")
        logger.info(f"🪣 Bucket S3: {bucket_name}")
        logger.info(f"📂 Préfixe: {prefix}")
        logger.info("")
        
        # Statistiques
        deleted_count = 0
        total_size = 0
        scanned_count = 0
        
        # Lister tous les objets dans le bucket avec le préfixe du hostname
        paginator = s3_client.get_paginator('list_objects_v2')
        
        logger.info("🔍 Recherche des fichiers à supprimer...")
        logger.info("")
        
        for page in paginator.paginate(Bucket=bucket_name, Prefix=prefix):
            if 'Contents' not in page:
                logger.info("ℹ️  Aucun fichier trouvé dans le bucket")
                break
            
            for obj in page['Contents']:
                scanned_count += 1
                key = obj['Key']
                last_modified = obj['LastModified']
                file_size = obj['Size']
                
                # Convertir en timezone aware si nécessaire
                if last_modified.tzinfo is None:
                    last_modified = pytz.utc.localize(last_modified)
                
                # Comparer avec la date limite
                if last_modified < cutoff_date:
                    try:
                        # Supprimer l'objet
                        s3_client.delete_object(Bucket=bucket_name, Key=key)
                        deleted_count += 1
                        total_size += file_size
                        
                        # Formater la taille pour l'affichage
                        if file_size < 1024:
                            size_str = f"{file_size} B"
                        elif file_size < 1024 * 1024:
                            size_str = f"{file_size / 1024:.2f} KB"
                        else:
                            size_str = f"{file_size / (1024 * 1024):.2f} MB"
                        
                        logger.info(f"🗑️  Supprimé: {key}")
                        logger.info(f"   └─ Taille: {size_str}")
                        logger.info(f"   └─ Modifié: {last_modified.strftime('%Y-%m-%d %H:%M:%S')}")
                        logger.info("")
                        
                    except ClientError as e:
                        logger.error(f"❌ Erreur lors de la suppression de {key}: {e}")
                        logger.info("")
        
        # Afficher le résumé
        logger.info("═══════════════════════════════════════════════════════════")
        logger.info("📊 RÉSUMÉ DU NETTOYAGE")
        logger.info("═══════════════════════════════════════════════════════════")
        logger.info(f"📁 Fichiers scannés: {scanned_count}")
        logger.info(f"🗑️  Fichiers supprimés: {deleted_count}")
        
        if total_size > 0:
            size_mb = total_size / (1024 * 1024)
            size_gb = total_size / (1024 * 1024 * 1024)
            
            if size_gb >= 1:
                logger.info(f"💾 Espace libéré: {size_gb:.2f} GB")
            else:
                logger.info(f"💾 Espace libéré: {size_mb:.2f} MB")
        else:
            logger.info(f"💾 Espace libéré: 0 MB")
        
        if deleted_count > 0:
            logger.info(f"✅ Nettoyage terminé avec succès")
        else:
            logger.info(f"ℹ️  Aucun fichier ancien à supprimer")
        
        logger.info("═══════════════════════════════════════════════════════════")
        
        return {
            "success": True,
            "scanned": scanned_count,
            "deleted": deleted_count,
            "size_freed": total_size
        }
        
    except NoCredentialsError:
        logger.error("❌ Credentials AWS non trouvées")
        logger.error("   Vérifiez les variables d'environnement:")
        logger.error("   - AWS_ACCESS_KEY_ID")
        logger.error("   - AWS_SECRET_ACCESS_KEY")
        logger.error("   - AWS_REGION")
        return {"success": False, "error": "Credentials AWS manquants"}
        
    except Exception as e:
        logger.error(f"❌ Erreur lors du nettoyage S3: {e}")
        logger.error(f"   Type: {type(e).__name__}")
        return {"success": False, "error": str(e)}


def main():
    """Point d'entrée principal"""
    parser = argparse.ArgumentParser(
        description='Nettoyage automatique des anciens logs Docker sur S3',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Exemples d'utilisation:
  python3 docker_log_s3_cleanup.py              # Supprime les logs de plus de 45 jours
  python3 docker_log_s3_cleanup.py --days 30    # Supprime les logs de plus de 30 jours
  python3 docker_log_s3_cleanup.py --days 90    # Supprime les logs de plus de 90 jours

Variables d'environnement requises:
  AWS_ACCESS_KEY_ID      Clé d'accès AWS
  AWS_SECRET_ACCESS_KEY  Clé secrète AWS
  AWS_REGION             Région AWS (ex: eu-west-3)
  AWS_LOGS_BUCKET        Nom du bucket S3 (ex: elyamaje-log-files)
        """
    )
    
    parser.add_argument(
        '--days',
        type=int,
        default=45,
        help='Nombre de jours avant suppression des logs (défaut: 45)'
    )
    
    args = parser.parse_args()
    
    # Valider le nombre de jours
    if args.days < 1:
        logger.error("❌ Le nombre de jours doit être supérieur à 0")
        sys.exit(1)
    
    if args.days < 7:
        logger.warning(f"⚠️  ATTENTION: Vous allez supprimer les logs de plus de {args.days} jours")
        logger.warning(f"⚠️  C'est une durée très courte. Êtes-vous sûr ?")
    
    # Lancer le nettoyage
    result = cleanup_old_s3_logs(days=args.days)
    
    # Code de sortie
    if result["success"]:
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
