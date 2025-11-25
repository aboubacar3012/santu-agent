# Tests locaux de  Agent

Ce guide décrit comment vérifier rapidement que l’agent fonctionne sur ta machine de développement (mode autonome, sans backend).

## 1. Prérequis

- Node.js 18+ et npm
- Docker en cours d’exécution avec accès au socket Unix `/var/run/docker.sock`
- Outil WebSocket pour les tests (ex. [`wscat`](https://www.npmjs.com/package/wscat))

```bash
# Installer wscat si besoin
npm install -g wscat
```

## 2. Préparer l’environnement

```bash
cd /Users/aboubacar/elyamaje/devoups-org/devoups-agent
npm install
cp .env .env.local.test   # ou crée un nouveau .env dédié aux tests
```

Dans ton fichier `.env`, vérifie au minimum :

```env
AGENT_TOKEN=dev-token
AGENT_CLIENT_TOKEN=frontend-token
AGENT_HOSTNAME=dev-machine
AGENT_FRONTEND_PORT=7080
DOCKER_SOCKET_PATH=/var/run/docker.sock
```

## 3. Lancer l’agent

```bash
npm run dev
```

Tu dois voir dans les logs :

- `Docker initialisé`
- `Serveur WebSocket frontend démarré`

## 4. Tester l’API WebSocket

### Connexion

```bash
wscat -c "ws://127.0.0.1:7081?token=your-agent-token&serverId=local-test"
```

En cas d’erreur `Invalid token`, vérifie `AGENT_CLIENT_TOKEN`.

### Commandes de base

Dans la session `wscat`, envoie des commandes JSON :

```json
{ "id": "req-1", "action": "docker.list", "params": {} }
```

```json
{
  "id": "req-2",
  "action": "docker.logs",
  "params": { "container": "nom-du-conteneur", "tail": 20 }
}
```

Tu dois recevoir des réponses `type: "response"` ou `type: "stream"` suivant l’action.

### Streaming temps réel

```json
{
  "id": "req-3",
  "action": "docker.logs",
  "params": { "container": "nom-du-conteneur", "follow": true }
}
```

L’agent renvoie d’abord une réponse de confirmation puis des messages `type: "stream"` à mesure que les logs arrivent. Ferme la connexion pour interrompre le flux.

## 5. Vérifications complémentaires

- **Arrêt/démarrage** : `docker.stop` puis `docker.start` sur un conteneur de test (évite ceux critiques).
- **Stats** : `docker.stats` avec `{"stream": true}` pour voir CPU/RAM en direct.
- **Exec** : `docker.exec` avec `{"command": ["ls","/app"]}` afin de valider l’exécution dans le conteneur.

Lorsque tous les tests passent (connexion WebSocket OK, actions Docker qui répondent correctement, streams temps réel fonctionnels), l’agent est prêt à être connecté à la plateforme principale.

