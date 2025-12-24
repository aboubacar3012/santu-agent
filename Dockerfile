FROM node:20-alpine

WORKDIR /app

# Configurer les serveurs DNS pour améliorer la résolution DNS
# Cela aide à résoudre les erreurs DNS transitoires lors de la construction
RUN echo "nameserver 8.8.8.8" > /etc/resolv.conf && \
    echo "nameserver 8.8.4.4" >> /etc/resolv.conf && \
    echo "nameserver 1.1.1.1" >> /etc/resolv.conf || true

# Installer les outils nécessaires pour parler au daemon Docker de l'hôte
# util-linux pour nsenter (permettre d'exécuter des commandes sur l'hôte)
# curl pour les requêtes HTTP (utilisé par Ansible pour vérifier l'installation)
# Ajout de retries pour gérer les erreurs DNS transitoires
RUN apk update --no-cache && \
    apk add --no-cache docker-cli util-linux curl || \
    (sleep 5 && apk update --no-cache && apk add --no-cache docker-cli util-linux curl) || \
    (sleep 10 && apk update --no-cache && apk add --no-cache docker-cli util-linux curl) || \
    (echo "Tentative avec miroir alternatif..." && \
    sed -i 's/dl-cdn.alpinelinux.org/mirror.rackspace.com\/alpine/g' /etc/apk/repositories && \
    apk update --no-cache && \
    apk add --no-cache docker-cli util-linux curl)

# Copier les manifestes npm
COPY package.json package-lock.json* ./

# Installer les dépendances (prod uniquement). On utilise npm install pour rester
# compatible même si package-lock.json n'est pas présent.
RUN npm install --omit=dev

# Copier le code source
COPY src/ ./src/
# COPY .env ./.env

# L'agent doit exécuter des opérations privilégiées (pilotage Docker, UFW, etc.).
# On conserve donc l'utilisateur root dans le conteneur.

# Exposer le port WebSocket agent → frontend
EXPOSE 7081

# Commande de démarrage
CMD ["node", "src/index.js"]




# docker build -t devoups-agent:latest .

# docker run -d \
#   --name devoups-agent \
#   --restart unless-stopped \
#   --privileged \
#   -v /var/run/docker.sock:/var/run/docker.sock \
#   -p 7081:7081 \
#   -e AGENT_TOKEN="kCYDJLUfDY1g8i1mVmOoxy" \
#   -e AGENT_HOSTNAME="vps-sandbox" \
#   devoups-agent:latest