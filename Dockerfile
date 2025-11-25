FROM node:20-alpine

WORKDIR /app

# Installer les outils nécessaires pour parler au daemon Docker de l'hôte.
RUN apk add --no-cache docker-cli

# Copier les manifestes npm
COPY package.json package-lock.json* ./

# Installer les dépendances (prod uniquement). On utilise npm install pour rester
# compatible même si package-lock.json n'est pas présent.
RUN npm install --omit=dev

# Copier le code source
COPY src/ ./src/

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