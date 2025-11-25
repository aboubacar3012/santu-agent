#!/bin/bash

# Script pour construire et publier l'image Docker de devoups-agent

# *************************** VARIABLES  ****************************
# Définir les variables
IMAGE_NAME="devoups-agent"
REGISTRY="ghcr.io"
REPO="elyamajeorg/devoups-agent"
# Format de date JJ-MM-AA-HH-MM
DATE_FORMAT=$(LC_TIME=fr_FR.UTF-8 TZ=Europe/Paris date +"%a_%d_%B_%Y_%Hh%M")

# *************************** GESTION VERSION ****************************
# Obtenir l'auteur du dernier commit si disponible
if [ -z "$GITHUB_ACTIONS" ]; then
  # Exécution locale
  COMMIT_AUTHOR=$(git log -1 --pretty=format:"%an" 2>/dev/null || echo "local")
  # Nettoyer le nom de l'auteur pour qu'il soit compatible avec les tags Docker (pas d'espaces)
  COMMIT_AUTHOR=$(echo "$COMMIT_AUTHOR" | tr ' ' '-' | tr '[:upper:]' '[:lower:]')
else
  # Dans GitHub Actions, utiliser l'acteur de l'événement
  COMMIT_AUTHOR=$GITHUB_ACTOR
fi

# Vérifier si nous sommes dans une Pull Request dans GitHub Actions
if [ -n "$GITHUB_ACTIONS" ] && [ -n "$GITHUB_HEAD_REF" ]; then
  # Nous sommes dans une PR
  # Extraire le numéro de PR
  PR_NUMBER=$(echo $GITHUB_REF | sed -n 's/refs\/pull\/\([0-9]*\)\/merge/\1/p')
  if [ -n "$PR_NUMBER" ]; then
    # Récupérer le titre de la PR via GitHub API
    PR_TITLE=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
               "https://api.github.com/repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" | \
               jq -r .title)
    
    # Nettoyer le titre pour qu'il soit utilisable comme tag Docker
    PR_TAG=$(echo "pr-$PR_NUMBER-${PR_TITLE}" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-_.' | cut -c 1-128)
    
    # Créer le tag avec la date et l'auteur
    TAG="${COMMIT_AUTHOR}-${DATE_FORMAT}-${PR_TAG}"
    echo "Pull Request détectée. Utilisation du tag: $TAG"
  else
    # Fallback si nous ne pouvons pas extraire le numéro de PR
    PR_BRANCH=$(echo $GITHUB_HEAD_REF | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-_.')
    TAG="${COMMIT_AUTHOR}-${DATE_FORMAT}-pr-${PR_BRANCH}"
  fi
else
  # Nous ne sommes pas dans une PR, utiliser la date et l'auteur
  TAG="${COMMIT_AUTHOR}-${DATE_FORMAT}"
  echo "Utilisation de la date et de l'auteur comme tag: $TAG"
fi

echo "Construction de l'image devoups-agent avec le tag: $TAG"

# *************************** ENVIRONNEMENT ****************************
# Formats supportés pour les clés privées dans le fichier .env :
# 1. Format avec \n : PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----"
# 2. Format multiligne (non recommandé pour .env mais supporté)
# 3. Avec ou sans guillemets
# Le script détecte automatiquement toute variable contenant "PRIVATE_KEY" dans son nom

# Définir la racine du projet
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
# Charger les variables d'environnement à partir du fichier .env à la racine du projet
if [ -f "$PROJECT_ROOT/.env" ]; then
  echo "Chargement des variables d'environnement depuis $PROJECT_ROOT/.env"
  
  # Charger toutes les variables d'environnement en excluant les clés privées et les commentaires
  set -a  # Export automatiquement toutes les variables
  source <(grep -v '^#' "$PROJECT_ROOT/.env" | grep -v '^$' | sed 's/\r$//') # | grep -v 'PRIVATE_KEY' 
  set +a  # Désactiver l'export automatique
  
else
  echo "Fichier .env non trouvé à la racine du projet. Certaines fonctionnalités comme la publication locale pourraient ne pas fonctionner sans PAT_GITHUB_TOKEN."
fi

# *************************** CONSTRUCTION DOCKER ****************************
# Construire l'image
echo "Construction de l'image Docker devoups-agent..."

# Se placer dans le répertoire du projet avant la construction
cd "$PROJECT_ROOT" || { echo "Erreur: Impossible d'accéder au répertoire $PROJECT_ROOT"; exit 1; }
echo "Répertoire de construction: $(pwd)"

# Mettre les guillemets pour éviter les problèmes d'interprétation # --no-cache \
docker build --platform=linux/amd64 -t "${IMAGE_NAME}:${TAG}" . 
  

# Vérifier si la construction a réussi
if [ $? -ne 0 ]; then
  echo "Échec de la construction de l'image Docker devoups-agent."
  exit 1
fi

echo "Image Docker devoups-agent construite avec succès: ${IMAGE_NAME}:${TAG}"

# Revenir au répertoire précédent si nécessaire ou aller à la racine du projet
cd ..

# *************************** EXÉCUTION LOCALE (OPTIONNELLE) ****************************
# Demander à l'utilisateur s'il souhaite exécuter l'image devoups-agent localement
read -p "Voulez-vous exécuter l'image devoups-agent localement? (y/n): " RUN_LOCALLY
if [[ $RUN_LOCALLY == "y" || $RUN_LOCALLY == "Y" ]]; then
  CONTAINER_NAME="${IMAGE_NAME}-${TAG}-local"

  # Vérifier si un conteneur avec le même nom existe déjà et le supprimer
  if [ $(docker ps -a -q -f name=^/${CONTAINER_NAME}$) ]; then
    echo "Un conteneur nommé ${CONTAINER_NAME} existe déjà. Suppression..."
    docker rm -f ${CONTAINER_NAME}
  fi

  echo "Exécution de l'image localement avec le nom de conteneur: ${CONTAINER_NAME}..."
  # Exposer le port 7081 et utiliser un format lisible avec retour à la ligne
  docker run -d \
    --restart unless-stopped \
    --privileged \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e AGENT_TOKEN="kCYDJLUfDY1g8i1mVmOoxy" \
    -e AGENT_HOSTNAME="vps-sandbox" \
    -p 7081:7081 \
    --name ${CONTAINER_NAME} \
    ${IMAGE_NAME}:${TAG}

  if [ $? -ne 0 ]; then
    echo "Échec du lancement du conteneur Docker."
  else
    echo "Conteneur ${CONTAINER_NAME} lancé avec succès sur le port 7081."
    echo "Pour voir les logs: docker logs ${CONTAINER_NAME}"
    echo "Pour arrêter le conteneur: docker stop ${CONTAINER_NAME}"
    echo "Pour supprimer le conteneur: docker rm ${CONTAINER_NAME}"
  fi
fi

# *************************** PUBLICATION ****************************
# Demander à l'utilisateur s'il souhaite publier l'image sur GitHub Container Registry
read -p "Voulez-vous publier l'image sur GitHub Container Registry? (y/n): " PUSH_IMAGE
if [[ $PUSH_IMAGE == "y" || $PUSH_IMAGE == "Y" ]]; then
  # Vérification GitHub Actions vs exécution locale
  if [ -n "$GITHUB_ACTIONS" ]; then
    echo "Exécution dans GitHub Actions, l'authentification sera faite avec PAT_GITHUB_TOKEN..."
  else
    # En environnement local, vérifier si le PAT_GITHUB_TOKEN est disponible dans les variables d'environnement
    if [ -z "$PAT_GITHUB_TOKEN" ]; then
      echo "PAT_GITHUB_TOKEN non trouvé dans le fichier .env Publication impossible."
      exit 1
    fi

    # Connexion à GitHub Container Registry localement
    echo "Connexion à GitHub Container Registry avec le token PAT depuis .env.."
    echo $PAT_GITHUB_TOKEN | docker login ${REGISTRY} -u elyamaje13 --password-stdin
  fi

  # Tag de l'image avec la date
  echo "Tag de l'image pour GitHub Container Registry..."
  docker tag ${IMAGE_NAME}:${TAG} ${REGISTRY}/${REPO}:${TAG}
  
  # Tag de l'image comme "latest"
  echo "Tag de l'image comme 'latest'..."
  docker tag ${IMAGE_NAME}:${TAG} ${REGISTRY}/${REPO}:latest

  # Publication de l'image avec la date
  echo "Publication de l'image sur GitHub Container Registry..."
  docker push ${REGISTRY}/${REPO}:${TAG}
  
  # Publication de l'image avec le tag "latest"
  echo "Publication de l'image avec le tag 'latest'..."
  docker push ${REGISTRY}/${REPO}:latest

  echo "Images publiées avec succès: ${REGISTRY}/${REPO}:${TAG} et ${REGISTRY}/${REPO}:latest"
fi

echo "Script terminé avec succès."