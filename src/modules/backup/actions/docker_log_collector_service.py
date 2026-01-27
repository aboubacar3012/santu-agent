#!/usr/bin/env python3
"""
###############################################################################
# SERVICE: Collecte et upload des logs Docker vers AWS S3
#
# DESCRIPTION:
# Ce script collecte automatiquement les logs de tous les containers Docker
# et les upload vers un bucket S3 AWS pour archivage et sauvegarde.
#
# FONCTIONNEMENT:
# 1. COLLECTE DES LOGS:
#    - Copie les fichiers de logs JSON Docker (*-json.log) vers des fichiers temporaires
#    - Manipule seulement les fichiers temporaires pour éviter de toucher aux originaux
#    - Parse les logs JSON pour séparer stdout et stderr
#    - Crée deux fichiers par container:
#      * container/date/heure_all.log (tous les logs)
#      * container/date/heure_errors.log (seulement les stderr)
#    - Utilise l'heure de Paris (UTC+1/UTC+2)
#
# 2. UPLOAD VERS S3:
#    - Compresse les logs en .log.gz
#    - Upload vers S3 avec structure: hostname/container/date/heure.log.gz
#    - Supprime les fichiers locaux après upload réussi
#
# 3. NETTOYAGE:
#    - Supprime les fichiers temporaires créés lors de la collecte
#    - Vide le répertoire temporaire /tmp/docker-logs/
#
# STRUCTURE S3 FINALE:
# s3://elyamaje-log-files/vps-old-dev-node/
# ├── elyamajeplay-backend/
# │   └── 2025-01-27/
# │       ├── 11h00min_all.log.gz
# │       ├── 11h00min_errors.log.gz
# │       ├── 12h00min_all.log.gz
# │       └── 12h00min_errors.log.gz
# └── elyamajeplay-dashboard/
#     └── 2025-01-27/
#         ├── 12h00min_all.log.gz
#         └── 12h00min_errors.log.gz
#
# VARIABLES:
# - hostname: récupéré automatiquement via socket.gethostname()
# - log_base_dir: /tmp/docker-logs (répertoire de collecte)
# - aws_env_file: /etc/._4d8f2.sh (fichier d'environnement AWS)
#
# USAGE:
# - Exécution manuelle: python3 docker_log_collector_service.py
# - Via cron : 0 * * * * (toutes les heures)
# - Logs: /var/log/docker-log-collector.log 
#
# DÉPENDANCES:
# - boto3>=1.26.0
# - botocore>=1.29.0
# - pytz>=2023.3
#
# SORTIE:
# - Logs collectés et uploadés vers S3
# - Fichiers temporaires nettoyés
# - Logs détaillés dans /var/log/docker-log-collector.log
###############################################################################
"""

import os
import sys
import json
import time
import gzip
import shutil
import logging
import socket
import subprocess
import boto3
import pytz
from datetime import datetime
from pathlib import Path
from botocore.exceptions import ClientError, NoCredentialsError

# Configuration du logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler("/var/log/docker-log-collector.log"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)


class DockerLogCollectorService:
    def __init__(self):
        # Récupérer le hostname du serveur
        self.hostname = socket.gethostname()
        self.log_base_dir = Path("/tmp/docker-logs")
        self.docker_log_dir = Path("/var/lib/docker/containers")
        self.aws_env_file = "/etc/._4d8f2.sh"

        # Charger les variables AWS
        self.load_aws_credentials()

        # Initialiser le client S3
        self.s3_client = boto3.client(
            "s3",
            aws_access_key_id=self.aws_access_key_id,
            aws_secret_access_key=self.aws_secret_access_key,
            region_name=self.aws_region,
        )

    def get_paris_time(self):
        """Retourne l'heure actuelle à Paris (UTC+1 ou UTC+2 selon l'heure d'été)"""
        # Utiliser pytz pour une gestion précise de l'heure de Paris
        paris_tz = pytz.timezone("Europe/Paris")
        paris_time = datetime.now(paris_tz)
        return paris_time

    def load_aws_credentials(self):
        """Charge les credentials AWS depuis le fichier d'environnement"""
        try:
            if os.path.exists(self.aws_env_file):
                with open(self.aws_env_file, "r") as f:
                    for line in f:
                        if line.startswith("export "):
                            key, value = (
                                line.replace("export ", "").strip().split("=", 1)
                            )
                            value = value.strip('"')
                            if key == "AWS_ACCESS_KEY_ID":
                                self.aws_access_key_id = value
                            elif key == "AWS_SECRET_ACCESS_KEY":
                                self.aws_secret_access_key = value
                            elif key == "AWS_REGION":
                                self.aws_region = value
                            elif key == "AWS_LOGS_BUCKET":
                                self.aws_logs_bucket = value

                # Vérifier que toutes les variables requises sont définies
                required_vars = [
                    "aws_access_key_id",
                    "aws_secret_access_key",
                    "aws_region",
                    "aws_logs_bucket",
                ]
                missing_vars = [var for var in required_vars if not hasattr(self, var)]

                if missing_vars:
                    logger.error(f"Variables AWS manquantes: {missing_vars}")
                    sys.exit(1)
            else:
                logger.error(
                    f"Fichier d'environnement AWS non trouvé: {self.aws_env_file}"
                )
                sys.exit(1)
        except Exception as e:
            logger.error(f"Erreur lors du chargement des credentials AWS: {e}")
            sys.exit(1)

    def collect_docker_logs(self):
        """Collecte les logs de tous les containers Docker en copiant les fichiers JSON"""
        try:
            # Créer le répertoire de base
            self.log_base_dir.mkdir(parents=True, exist_ok=True)

            # Obtenir la date et heure actuelles à Paris
            now = self.get_paris_time()
            date_str = now.strftime("%Y-%m-%d")
            time_str = now.strftime("%Hh%Mmin")

            collected_logs = []
            temp_files_to_cleanup = []  # Liste des fichiers temporaires à nettoyer

            # Parcourir tous les containers Docker
            for container_dir in self.docker_log_dir.iterdir():
                if container_dir.is_dir():
                    container_id = container_dir.name

                    # Obtenir le nom du container depuis Docker
                    try:
                        result = subprocess.run(
                            [
                                "docker",
                                "inspect",
                                "--format",
                                "{{.Name}}",
                                container_id,
                            ],
                            capture_output=True,
                            text=True,
                            timeout=30,
                        )
                        if result.returncode == 0:
                            container_name = result.stdout.strip().lstrip("/")
                        else:
                            container_name = container_id
                    except Exception:
                        container_name = container_id

                    # Créer le répertoire pour ce container
                    container_log_dir = self.log_base_dir / container_name / date_str
                    container_log_dir.mkdir(parents=True, exist_ok=True)

                    # Chercher les fichiers de logs JSON
                    log_files = list(container_dir.glob("*-json.log"))

                    for log_file in log_files:
                        try:
                            # Créer une copie temporaire du fichier de log
                            temp_log_file = (
                                container_log_dir
                                / f"{container_id}_{log_file.name}_temp"
                            )
                            shutil.copy2(log_file, temp_log_file)
                            temp_files_to_cleanup.append(str(temp_log_file))

                            # Lire le contenu du fichier temporaire
                            try:
                                with open(temp_log_file, "r", encoding="utf-8") as f:
                                    log_lines = f.readlines()
                            except UnicodeDecodeError:
                                # Essayer avec un encodage différent si UTF-8 échoue
                                with open(temp_log_file, "r", encoding="latin-1") as f:
                                    log_lines = f.readlines()

                            if log_lines:
                                # Créer le nom du fichier de sortie avec l'heure actuelle à Paris
                                current_time = self.get_paris_time()
                                time_str = current_time.strftime("%Hh%Mmin")

                                # Séparer les logs stdout et stderr
                                all_logs = []
                                error_logs = []

                                # Calculer le timestamp de 1h en arrière
                                one_hour_ago = time.time() - 3600  # 1 heure en secondes

                                total_lines = len(log_lines)
                                processed_lines = 0
                                kept_lines = 0

                                for line in log_lines:
                                    try:
                                        # Parser la ligne JSON Docker
                                        log_entry = json.loads(line.strip())

                                        processed_lines += 1

                                        # Vérifier si le log date de moins d'1h
                                        log_timestamp = log_entry.get("time", "")
                                        if log_timestamp:
                                            # Convertir le timestamp en secondes
                                            try:
                                                # Le timestamp Docker est au format "2024-01-27T10:30:45.123456789Z"
                                                log_time = datetime.fromisoformat(
                                                    log_timestamp.replace("Z", "+00:00")
                                                )
                                                log_timestamp_seconds = (
                                                    log_time.timestamp()
                                                )

                                                # Ne garder que les logs de la dernière heure
                                                if (
                                                    log_timestamp_seconds
                                                    >= one_hour_ago
                                                ):
                                                    kept_lines += 1
                                                    # Ajouter à tous les logs
                                                    all_logs.append(line)

                                                    # Ajouter aux erreurs si c'est stderr
                                                    if (
                                                        log_entry.get("stream")
                                                        == "stderr"
                                                    ):
                                                        error_logs.append(line)
                                            except (ValueError, TypeError):
                                                # Si le timestamp est invalide, ignorer cette ligne
                                                continue
                                        else:
                                            # Si pas de timestamp, ignorer cette ligne
                                            continue

                                    except json.JSONDecodeError:
                                        # Si ce n'est pas du JSON valide, ignorer cette ligne
                                        continue

                                # Créer le fichier avec tous les logs
                                if all_logs:
                                    output_file_all = (
                                        container_log_dir / f"{time_str}_all.log"
                                    )
                                    with open(
                                        output_file_all, "w", encoding="utf-8"
                                    ) as f:
                                        f.writelines(all_logs)
                                    collected_logs.append(str(output_file_all))
                                    logger.info(
                                        f"Log complet collecté: {output_file_all} ({kept_lines}/{total_lines} lignes depuis 1h)"
                                    )
                                else:
                                    logger.info(
                                        f"Aucun log récent trouvé pour le container: {container_name} (traité {total_lines} lignes)"
                                    )

                                # Créer le fichier avec seulement les erreurs
                                if error_logs:
                                    output_file_errors = (
                                        container_log_dir / f"{time_str}_errors.log"
                                    )
                                    with open(
                                        output_file_errors, "w", encoding="utf-8"
                                    ) as f:
                                        f.writelines(error_logs)
                                    collected_logs.append(str(output_file_errors))
                                    logger.info(
                                        f"Log erreurs collecté: {output_file_errors} ({len(error_logs)} lignes d'erreur)"
                                    )
                                else:
                                    logger.info(
                                        f"Aucune erreur détectée pour le container: {container_name}"
                                    )

                        except Exception as e:
                            logger.error(
                                f"Erreur lors de la lecture du log {log_file}: {e}"
                            )

            logger.info(
                f"Collecte terminée. {len(collected_logs)} fichiers de logs collectés."
            )

            # Stocker la liste des fichiers temporaires à nettoyer
            self.temp_files_to_cleanup = temp_files_to_cleanup

            return collected_logs

        except Exception as e:
            logger.error(f"Erreur lors de la collecte des logs: {e}")
            return []

    def upload_to_s3(self, log_files):
        """Upload les fichiers de logs vers S3"""
        if not log_files:
            logger.info("Aucun fichier à uploader.")
            return

        try:
            uploaded_count = 0

            for log_file_path in log_files:
                log_file = Path(log_file_path)

                if not log_file.exists():
                    logger.warning(f"Fichier non trouvé: {log_file}")
                    continue

                # Créer le chemin S3 avec extension .log.gz
                relative_path = log_file.relative_to(self.log_base_dir)
                s3_key = f"{self.hostname}/{relative_path}.gz"

                # Compresser le fichier
                compressed_file = log_file.with_suffix(".log.gz")
                with open(log_file, "rb") as f_in:
                    with gzip.open(compressed_file, "wb") as f_out:
                        shutil.copyfileobj(f_in, f_out)

                # Upload vers S3
                try:
                    self.s3_client.upload_file(
                        str(compressed_file), self.aws_logs_bucket, s3_key
                    )
                    logger.info(f"Upload réussi: s3://{self.aws_logs_bucket}/{s3_key}")
                    uploaded_count += 1

                    # Supprimer les fichiers locaux après upload réussi
                    log_file.unlink()
                    compressed_file.unlink()

                except (ClientError, NoCredentialsError) as e:
                    logger.error(f"Erreur lors de l'upload de {log_file}: {e}")
                    # Nettoyer le fichier compressé temporaire
                    if compressed_file.exists():
                        compressed_file.unlink()

            logger.info(f"Upload terminé. {uploaded_count} fichiers uploadés vers S3.")

            # Nettoyer les fichiers temporaires et vider le répertoire temporaire après upload réussi
            if uploaded_count > 0:
                self.cleanup_temp_files()
                self.cleanup_temp_logs()

        except Exception as e:
            logger.error(f"Erreur lors de l'upload vers S3: {e}")

    def cleanup_old_logs(self):
        """Nettoie les anciens logs locaux (plus de 7 jours)"""
        try:
            current_time = time.time()
            max_age = 7 * 24 * 3600  # 7 jours en secondes

            # Chercher les fichiers _all.log et _errors.log
            for log_file in self.log_base_dir.rglob("*_all.log"):
                if current_time - log_file.stat().st_mtime > max_age:
                    log_file.unlink()
                    logger.info(f"Ancien log complet supprimé: {log_file}")

            for log_file in self.log_base_dir.rglob("*_errors.log"):
                if current_time - log_file.stat().st_mtime > max_age:
                    log_file.unlink()
                    logger.info(f"Ancien log erreurs supprimé: {log_file}")

        except Exception as e:
            logger.error(f"Erreur lors du nettoyage: {e}")

    def cleanup_temp_logs(self):
        """Vide complètement le répertoire /tmp/docker-logs après upload réussi"""
        try:
            if self.log_base_dir.exists():
                # Supprimer tout le contenu du répertoire
                shutil.rmtree(self.log_base_dir)
                # Recréer le répertoire vide
                self.log_base_dir.mkdir(parents=True, exist_ok=True)
                logger.info(f"Répertoire temporaire vidé: {self.log_base_dir}")
            else:
                logger.info(f"Répertoire temporaire n'existe pas: {self.log_base_dir}")

        except Exception as e:
            logger.error(f"Erreur lors du nettoyage du répertoire temporaire: {e}")

    def cleanup_temp_files(self):
        """Nettoie les fichiers temporaires créés lors de la collecte"""
        if not hasattr(self, "temp_files_to_cleanup"):
            return

        try:
            cleaned_count = 0
            for temp_file_path in self.temp_files_to_cleanup:
                try:
                    temp_file = Path(temp_file_path)
                    if temp_file.exists():
                        temp_file.unlink()
                        cleaned_count += 1
                        logger.info(f"Fichier temporaire supprimé: {temp_file}")
                except Exception as e:
                    logger.error(
                        f"Erreur lors de la suppression du fichier temporaire {temp_file_path}: {e}"
                    )

            logger.info(
                f"Nettoyage terminé. {cleaned_count} fichiers temporaires supprimés."
            )

            # Vider la liste après traitement
            self.temp_files_to_cleanup = []

        except Exception as e:
            logger.error(f"Erreur lors du nettoyage des fichiers temporaires: {e}")



def main():
    """Point d'entrée principal"""
    service = DockerLogCollectorService()
    
    # Mode normal : collecte et upload en continu
    # Intervalles en secondes
    COLLECT_INTERVAL = 2 * 60  # 2 minutes
    UPLOAD_INTERVAL = 1 * 3600  # 1 heure
    
    # Timestamps de la dernière exécution
    last_collect_time = 0
    last_upload_time = 0
    
    # Première collecte immédiate
    logger.info("Première collecte immédiate...")
    service.collect_docker_logs()
    last_collect_time = time.time()
    
    # Boucle principale
    try:
        while True:
            current_time = time.time()
            
            # Collecte toutes les 2 minutes
            if current_time - last_collect_time >= COLLECT_INTERVAL:
                try:
                    logger.info("Début de la collecte des logs...")
                    service.collect_docker_logs()
                    last_collect_time = current_time
                    logger.info("Collecte terminée.")
                except Exception as e:
                    logger.error(f"Erreur lors de la collecte: {e}")
            
            # Upload toutes les 1 heure
            if current_time - last_upload_time >= UPLOAD_INTERVAL:
                try:
                    logger.info("Début de l'upload des logs vers S3...")
                    log_files = []
                    if service.log_base_dir.exists():
                        for log_file in service.log_base_dir.rglob("*_all.log"):
                            log_files.append(str(log_file))
                        for log_file in service.log_base_dir.rglob("*_errors.log"):
                            log_files.append(str(log_file))
                    
                    if log_files:
                        service.upload_to_s3(log_files)
                        service.cleanup_old_logs()
                    else:
                        logger.info("Aucun fichier de log à uploader.")
                    
                    last_upload_time = current_time
                    logger.info("Upload terminé.")
                except Exception as e:
                    logger.error(f"Erreur lors de l'upload: {e}")
            
            # Attendre 30 secondes avant de vérifier à nouveau
            time.sleep(30)
            
    except KeyboardInterrupt:
        logger.info("Arrêt du service demandé par l'utilisateur")


if __name__ == "__main__":
    main()
