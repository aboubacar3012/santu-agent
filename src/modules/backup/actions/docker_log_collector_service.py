#!/usr/bin/env python3
"""
###############################################################################
SERVICE: Collecte et upload des logs Docker vers AWS S3

DESCRIPTION:
Ce script collecte automatiquement les logs de tous les containers Docker
et les upload vers un bucket S3 AWS pour archivage et sauvegarde.

FONCTIONNEMENT:
1. COLLECTE DES LOGS (toutes les 2 minutes):
   - Copie les fichiers de logs JSON Docker (*-json.log) vers des fichiers temporaires
   - Manipule seulement les fichiers temporaires pour éviter de toucher aux originaux
   - Parse les logs JSON pour séparer stdout et stderr
   - Collecte uniquement les logs des 2 dernières minutes
   - Accumule les logs dans des fichiers temporaires par heure:
     * container/date/10h00min_all.log (tous les logs de 10h00 à 10h59)
     * container/date/10h00min_errors.log (seulement les stderr de 10h00 à 10h59)
   - Utilise l'heure de Paris (UTC+1/UTC+2)

2. UPLOAD VERS S3 (toutes les heures):
   - Upload seulement au début de chaque heure (dans les 2 premières minutes)
   - Upload les fichiers temporaires de l'heure précédente
   - Compresse les logs en .log.gz
   - Upload vers S3 avec structure: env/container/date/heure.log.gz
   - Supprime les fichiers locaux après upload réussi

3. NETTOYAGE:
   - Supprime les fichiers temporaires créés lors de la collecte
   - Nettoie les fichiers temporaires de l'heure précédente après upload

STRUCTURE S3 FINALE:
s3://elyamaje-log-files/prod/
├── elyamajeplay-backend/
│   └── 2025-01-27/
│       ├── 11h00min_all.log.gz
│       ├── 11h00min_errors.log.gz
│       ├── 12h00min_all.log.gz
│       └── 12h00min_errors.log.gz
└── elyamajeplay-dashboard/
    └── 2025-01-27/
        ├── 12h00min_all.log.gz
        └── 12h00min_errors.log.gz

VARIABLES:
- env: prod (environnement: dev, sandbox, prod)
- log_base_dir: /tmp/docker-logs (répertoire de collecte)
- aws_env_file: /etc/._4d8f2.sh (fichier d'environnement AWS)

USAGE:
- Exécution manuelle: python3 docker_log_collector_service.py --env prod
- Via cron: toutes les 2 minutes (format cron: toutes les 2 minutes)
- Logs: /var/log/docker-log-collector.log

DÉPENDANCES:
- boto3
- pytz

SORTIE:
- Logs collectés et uploadés vers S3
- Fichiers temporaires nettoyés
- Logs détaillés dans /var/log/docker-log-collector.log
###############################################################################
"""

import os
import sys
import json
import gzip
import shutil
import argparse
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
import boto3
from botocore.exceptions import ClientError
import pytz

# Logger simple pour le script standalone
LOG_FILE = "/var/log/docker-log-collector.log"

def log(level, message, *args):
    """Log un message avec timestamp"""
    timestamp = datetime.utcnow().isoformat() + "Z"
    args_str = " ".join(str(a) if not isinstance(a, dict) else json.dumps(a) for a in args)
    log_message = f"[{timestamp}] [{level}] {message} {args_str}\n"
    
    # Écrire dans le fichier de log
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(log_message)
    except Exception:
        # Si on ne peut pas écrire dans le fichier, afficher sur stderr
        print(log_message, file=sys.stderr)
    
    # Aussi afficher sur stdout/stderr pour le cron
    if level in ("ERROR", "WARN"):
        print(log_message.strip(), file=sys.stderr)
    else:
        print(log_message.strip())

class DockerLogCollectorService:
    def __init__(self, env="sandbox"):
        self.env = env
        self.log_base_dir = "/tmp/docker-logs"
        self.docker_log_dir = "/var/lib/docker/containers"
        self.aws_env_file = "/etc/._4d8f2.sh"
        
        # Charger les variables AWS
        self.load_aws_credentials()
        
        # Initialiser le client S3
        self.s3_client = boto3.client(
            's3',
            region_name=self.aws_region,
            aws_access_key_id=self.aws_access_key_id,
            aws_secret_access_key=self.aws_secret_access_key
        )
    
    def get_paris_time(self):
        """Retourne un objet datetime à Paris"""
        paris_tz = pytz.timezone('Europe/Paris')
        return datetime.now(paris_tz)
    
    def load_aws_credentials(self):
        """Charge les credentials AWS depuis le fichier d'environnement"""
        try:
            if not os.path.exists(self.aws_env_file):
                log("ERROR", f"Fichier d'environnement AWS non trouvé: {self.aws_env_file}")
                sys.exit(1)
            
            # Lire et parser le fichier
            with open(self.aws_env_file, "r", encoding="utf-8") as f:
                content = f.read()
            
            for line in content.split("\n"):
                if line.startswith("export "):
                    cleaned = line.replace("export ", "").strip()
                    if "=" in cleaned:
                        key, value = cleaned.split("=", 1)
                        value = value.strip().strip('"').strip("'")
                        
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
                "aws_logs_bucket"
            ]
            missing_vars = [var for var in required_vars if not hasattr(self, var) or not getattr(self, var)]
            
            if missing_vars:
                log("ERROR", f"Variables AWS manquantes: {', '.join(missing_vars)}")
                sys.exit(1)
        except Exception as error:
            log("ERROR", f"Erreur lors du chargement des credentials AWS: {error}")
            sys.exit(1)
    
    def collect_docker_logs(self):
        """Collecte les logs Docker des 2 dernières minutes"""
        try:
            log("INFO", "Début de la collecte des logs Docker")
            collected_logs = []
            two_minutes_ago = (datetime.now() - timedelta(minutes=2)).timestamp()
            
            # Parcourir tous les containers
            if not os.path.exists(self.docker_log_dir):
                log("WARN", f"Répertoire Docker non trouvé: {self.docker_log_dir}")
                return collected_logs
            
            for container_id in os.listdir(self.docker_log_dir):
                container_path = os.path.join(self.docker_log_dir, container_id)
                if not os.path.isdir(container_path):
                    continue
                
                # Récupérer le nom du container
                try:
                    result = subprocess.run(
                        ['docker', 'inspect', '--format', '{{.Name}}', container_id],
                        capture_output=True,
                        text=True,
                        timeout=30
                    )
                    if result.stdout and result.stdout.strip():
                        container_name = result.stdout.strip().lstrip('/')
                    else:
                        container_name = container_id[:12]
                except Exception:
                    container_name = container_id[:12]
                
                # Date actuelle à Paris
                now_paris = self.get_paris_time()
                date_str = now_paris.strftime("%Y-%m-%d")
                hour_str = f"{now_paris.hour:02d}h00min"
                
                # Créer le répertoire pour ce container
                container_log_dir = os.path.join(self.log_base_dir, container_name, date_str)
                os.makedirs(container_log_dir, exist_ok=True)
                
                # Chercher les fichiers de logs JSON
                log_files = [f for f in os.listdir(container_path) if f.endswith("-json.log")]
                
                if not log_files:
                    continue
                
                for log_file_name in log_files:
                    log_file_path = os.path.join(container_path, log_file_name)
                    
                    try:
                        # Copier le fichier temporairement
                        temp_log_file = os.path.join(container_log_dir, f"{container_id}_{log_file_name}_temp")
                        shutil.copy2(log_file_path, temp_log_file)
                        
                        # Lire et parser les logs
                        new_all_logs = []
                        new_error_logs = []
                        
                        with open(temp_log_file, "r", encoding="utf-8", errors="ignore") as f:
                            for line in f:
                                try:
                                    log_entry = json.loads(line.strip())
                                    log_time_str = log_entry.get("time", "")
                                    
                                    if log_time_str:
                                        # Parser le timestamp
                                        log_time = datetime.fromisoformat(log_time_str.replace("Z", "+00:00"))
                                        log_timestamp = log_time.timestamp()
                                        
                                        # Vérifier si le log est dans les 2 dernières minutes
                                        if log_timestamp >= two_minutes_ago:
                                            log_output = log_entry.get("log", "")
                                            stream = log_entry.get("stream", "stdout")
                                            
                                            if stream == "stderr":
                                                new_error_logs.append(log_output)
                                            new_all_logs.append(log_output)
                                except (json.JSONDecodeError, ValueError, KeyError):
                                    continue
                        
                        # Écrire dans les fichiers temporaires par heure
                        if new_all_logs:
                            output_file_all = os.path.join(container_log_dir, f"{hour_str}_all.log")
                            with open(output_file_all, "a", encoding="utf-8") as f:
                                f.writelines(new_all_logs)
                            
                            if output_file_all not in collected_logs:
                                collected_logs.append(output_file_all)
                            
                            kept_lines = len(new_all_logs)
                            log("INFO", f"Logs ajoutés au fichier temporaire: {output_file_all} ({kept_lines} nouvelles lignes des 2 dernières minutes)")
                        
                        if new_error_logs:
                            output_file_errors = os.path.join(container_log_dir, f"{hour_str}_errors.log")
                            with open(output_file_errors, "a", encoding="utf-8") as f:
                                f.writelines(new_error_logs)
                            
                            if output_file_errors not in collected_logs:
                                collected_logs.append(output_file_errors)
                            
                            log("INFO", f"Erreurs ajoutées au fichier temporaire: {output_file_errors} ({len(new_error_logs)} nouvelles lignes d'erreur)")
                        
                        # Supprimer le fichier temporaire
                        if os.path.exists(temp_log_file):
                            os.unlink(temp_log_file)
                    except Exception as error:
                        log("ERROR", f"Erreur lors de la lecture du log {log_file_name}: {error}")
                        continue
            
            log("INFO", f"Collecte terminée. {len(collected_logs)} fichiers temporaires mis à jour.")
            return collected_logs
        except Exception as error:
            log("ERROR", f"Erreur lors de la collecte des logs: {error}")
            return []
    
    def should_upload(self):
        """Retourne True si on doit uploader (dans les 2 premières minutes de l'heure)"""
        now_paris = self.get_paris_time()
        return now_paris.minute < 2
    
    def upload_to_s3(self, log_files):
        """Upload les logs vers S3 (seulement si on est dans les 2 premières minutes de l'heure)"""
        if not self.should_upload():
            log("INFO", "Ce n'est pas le moment d'uploader (seulement dans les 2 premières minutes de l'heure)")
            return
        
        try:
            # Calculer l'heure précédente
            now_paris = self.get_paris_time()
            previous_hour = now_paris - timedelta(hours=1)
            previous_date_str = previous_hour.strftime("%Y-%m-%d")
            previous_hour_str = f"{previous_hour.hour:02d}h00min"
            
            files_to_upload = []
            
            # Parcourir tous les containers
            if os.path.exists(self.log_base_dir):
                for container_dir_name in os.listdir(self.log_base_dir):
                    container_dir = os.path.join(self.log_base_dir, container_dir_name)
                    if not os.path.isdir(container_dir):
                        continue
                    
                    date_dir = os.path.join(container_dir, previous_date_str)
                    if os.path.exists(date_dir):
                        # Chercher les fichiers de l'heure précédente
                        for file_name in os.listdir(date_dir):
                            if file_name.startswith(previous_hour_str) and file_name.endswith(".log"):
                                file_path = os.path.join(date_dir, file_name)
                                if os.path.isfile(file_path):
                                    files_to_upload.append(file_path)
            
            if not files_to_upload:
                log("INFO", "Aucun fichier à uploader pour l'heure précédente")
                return
            
            log("INFO", f"Début de l'upload de {len(files_to_upload)} fichiers vers S3")
            uploaded_count = 0
            
            for log_file in files_to_upload:
                if not os.path.exists(log_file):
                    log("WARN", f"Fichier non trouvé: {log_file}")
                    continue
                
                # Créer le chemin S3 avec extension .log.gz
                relative_path = log_file.replace(self.log_base_dir + "/", "")
                s3_key = f"{self.env}/{relative_path}.gz"
                
                # Compresser le fichier
                compressed_file = log_file + ".gz"
                try:
                    with open(log_file, "rb") as f_in:
                        with gzip.open(compressed_file, "wb") as f_out:
                            shutil.copyfileobj(f_in, f_out)
                    
                    # Upload vers S3
                    with open(compressed_file, "rb") as f:
                        self.s3_client.put_object(
                            Bucket=self.aws_logs_bucket,
                            Key=s3_key,
                            Body=f
                        )
                    
                    log("INFO", f"Upload réussi: s3://{self.aws_logs_bucket}/{s3_key}")
                    uploaded_count += 1
                    
                    # Supprimer les fichiers locaux après upload réussi
                    os.unlink(log_file)
                    os.unlink(compressed_file)
                except Exception as error:
                    log("ERROR", f"Erreur lors de l'upload de {log_file}: {error}")
                    # Nettoyer le fichier compressé temporaire
                    if os.path.exists(compressed_file):
                        os.unlink(compressed_file)
            
            log("INFO", f"Upload terminé. {uploaded_count} fichiers uploadés vers S3.")
            
            # Nettoyer les fichiers temporaires après upload réussi
            if uploaded_count > 0:
                self.cleanup_temp_files()
                self.cleanup_temp_logs()
        except Exception as error:
            log("ERROR", f"Erreur lors de l'upload vers S3: {error}")
    
    def cleanup_old_logs(self):
        """Nettoie les anciens logs locaux (plus de 7 jours)"""
        try:
            max_age = 7 * 24 * 60 * 60  # 7 jours en secondes
            current_time = datetime.now().timestamp()
            
            if os.path.exists(self.log_base_dir):
                for container_dir_name in os.listdir(self.log_base_dir):
                    container_dir = os.path.join(self.log_base_dir, container_dir_name)
                    if not os.path.isdir(container_dir):
                        continue
                    
                    for date_dir_name in os.listdir(container_dir):
                        date_dir = os.path.join(container_dir, date_dir_name)
                        if not os.path.isdir(date_dir):
                            continue
                        
                        for file_name in os.listdir(date_dir):
                            file_path = os.path.join(date_dir, file_name)
                            if os.path.isfile(file_path):
                                file_time = os.path.getmtime(file_path)
                                if current_time - file_time > max_age:
                                    os.unlink(file_path)
                                    log("INFO", f"Ancien log supprimé: {file_path}")
        except Exception as error:
            log("ERROR", f"Erreur lors du nettoyage des anciens logs: {error}")
    
    def cleanup_temp_files(self):
        """Nettoie les fichiers temporaires créés lors de la collecte"""
        try:
            if os.path.exists(self.log_base_dir):
                for container_dir_name in os.listdir(self.log_base_dir):
                    container_dir = os.path.join(self.log_base_dir, container_dir_name)
                    if not os.path.isdir(container_dir):
                        continue
                    
                    for date_dir_name in os.listdir(container_dir):
                        date_dir = os.path.join(container_dir, date_dir_name)
                        if not os.path.isdir(date_dir):
                            continue
                        
                        for file_name in os.listdir(date_dir):
                            if "_temp" in file_name:
                                file_path = os.path.join(date_dir, file_name)
                                if os.path.isfile(file_path):
                                    os.unlink(file_path)
        except Exception as error:
            log("ERROR", f"Erreur lors du nettoyage des fichiers temporaires: {error}")
    
    def cleanup_temp_logs(self):
        """Nettoie les fichiers temporaires de l'heure précédente après upload"""
        try:
            now_paris = self.get_paris_time()
            previous_hour = now_paris - timedelta(hours=1)
            previous_date_str = previous_hour.strftime("%Y-%m-%d")
            previous_hour_str = f"{previous_hour.hour:02d}h00min"
            
            if os.path.exists(self.log_base_dir):
                for container_dir_name in os.listdir(self.log_base_dir):
                    container_dir = os.path.join(self.log_base_dir, container_dir_name)
                    if not os.path.isdir(container_dir):
                        continue
                    
                    date_dir = os.path.join(container_dir, previous_date_str)
                    if os.path.exists(date_dir):
                        for file_name in os.listdir(date_dir):
                            if file_name.startswith(previous_hour_str) and file_name.endswith(".log"):
                                file_path = os.path.join(date_dir, file_name)
                                if os.path.isfile(file_path):
                                    os.unlink(file_path)
                                    log("INFO", f"Fichier temporaire supprimé: {file_path}")
        except Exception as error:
            log("ERROR", f"Erreur lors du nettoyage des fichiers temporaires: {error}")

def main():
    """Point d'entrée principal"""
    parser = argparse.ArgumentParser(description="Collecte et upload des logs Docker vers S3")
    parser.add_argument("--env", default="sandbox", help="Environnement (dev, sandbox, prod)")
    args = parser.parse_args()
    
    service = DockerLogCollectorService(env=args.env)
    
    # Exécution unique (pour cron)
    log_files = service.collect_docker_logs()
    service.upload_to_s3(log_files)
    service.cleanup_old_logs()

if __name__ == "__main__":
    main()
