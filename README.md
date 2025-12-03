#  Agent

Agent léger et modulaire pour la gestion des serveurs distants via WebSocket. Architecture extensible permettant d'ajouter facilement de nouveaux modules (Docker, SSH, etc.).

## 🚀 Fonctionnalités

- **Architecture modulaire** : Système extensible permettant d'ajouter facilement de nouveaux modules
- **Gestion Docker** : Liste, démarrage, arrêt, redémarrage de conteneurs
- **Gestion SSH** : Récupération des clés SSH du serveur avec déduplication automatique
- **Logs en temps réel** : Récupération et streaming des logs Docker
- **Statistiques** : Monitoring des performances des conteneurs
- **Communication WebSocket** : Serveur WebSocket pour connexions frontend directes
- **Sécurité** : Validation des commandes, sanitization des paramètres, authentification par token

## 📋 Prérequis

- Node.js 18+
- Docker installé et en cours d'exécution
- Accès au socket Docker (`/var/run/docker.sock`)

## 🛠️ Installation

```bash
# Installer les dépendances
npm install

# Copier le fichier d'environnement
cp .env.example .env

# Modifier .env selon vos besoins
```

## ⚙️ Configuration

Variables d'environnement (`.env`) :

```env
# Authentification (utilisée côté agent et par défaut côté frontend)
AGENT_TOKEN=your-agent-token

# Jeton dédié pour les clients frontend (optionnel)
# AGENT_CLIENT_TOKEN=your-frontend-token

# Identification du serveur
AGENT_HOSTNAME=server-01

# Serveur WebSocket Frontend
AGENT_FRONTEND_HOST=0.0.0.0
AGENT_FRONTEND_PORT=7080

# Logs
AGENT_LOG_LEVEL=info
```

## 🚀 Utilisation

### Développement

```bash
npm run dev
```

### Production

```bash
npm start
```

### Avec Docker

```bash
# Construire l'image
docker build -t devoups-agent:latest .

# Lancer le conteneur (mode autonome avec serveur WebSocket frontend)
docker run -d \
  --name devoups-agent \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -p 7080:7080 \
  -e AGENT_TOKEN=your-token \
  -e AGENT_HOSTNAME=server-01 \
  -e AGENT_FRONTEND_PORT=7080 \
  devoups-agent:latest
```

### Avec Docker Compose

```bash
docker-compose up -d
```

> **Note** : Le `docker-compose.yml` utilise `network_mode: host`, donc le serveur WebSocket frontend est directement accessible sur le port `AGENT_FRONTEND_PORT` (par défaut 7080) sans mapping de port supplémentaire.

## 📡 Protocole de communication

L'agent accepte les messages envoyés par le frontend via le serveur WebSocket exposé.

### Messages reçus (frontend)

```json
{
  "id": "uuid-request",
  "action": "docker.list",
  "params": {}
}
```

```json
{
  "id": "uuid-request",
  "action": "docker.start",
  "params": {
    "container": "webapp-container"
  }
}
```

```json
{
  "id": "uuid-request",
  "action": "docker.logs",
  "params": {
    "container": "webapp-container",
    "tail": 100,
    "follow": true
  }
}
```

```json
{
  "id": "uuid-request",
  "action": "ssh.list",
  "params": {}
}
```

### Messages envoyés (vers frontend)

**Réponse de succès :**
```json
{
  "type": "response",
  "id": "uuid-request",
  "success": true,
  "data": { ... }
}
```

**Stream de logs :**
```json
{
  "type": "stream",
  "id": "uuid-request",
  "stream": "stdout",
  "data": "Container started successfully"
}
```

## 🐳 Actions Docker supportées

- `docker.list` - Liste les conteneurs
- `docker.inspect` - Inspecte un conteneur
- `docker.start` - Démarre un conteneur
- `docker.stop` - Arrête un conteneur
- `docker.restart` - Redémarre un conteneur
- `docker.logs` - Récupère les logs (avec option `follow` pour le streaming)
- `docker.stats` - Récupère les statistiques (avec option `stream` pour le temps réel)
- `docker.exec` - Exécute une commande dans un conteneur

## 🔐 Actions SSH supportées

- `ssh.list` - Liste toutes les clés SSH publiques du serveur (parcourt tous les utilisateurs, élimine les doublons)

### Format de réponse SSH

```json
{
  "type": "response",
  "id": "uuid-request",
  "success": true,
  "data": [
    {
      "publicKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...",
      "type": "ed25519",
      "users": ["user1", "user2"],
      "sources": [
        "/home/user1/.ssh/authorized_keys",
        "/home/user2/.ssh/id_ed25519.pub"
      ],
      "fingerprint": null
    }
  ]
}
```

## 🏗️ Architecture

```
devoups-agent/
├── src/
│   ├── index.js                 # Point d'entrée
│   ├── config/
│   │   └── env.js               # Configuration
│   ├── websocket/
│   │   ├── server.js            # Serveur WebSocket (frontend)
│   │   └── handlers.js          # Routeur générique de messages
│   ├── shared/                  # Utilitaires partagés entre tous les modules
│   │   ├── logger.js            # Logger structuré
│   │   ├── executor.js          # Exécution sécurisée de commandes
│   │   └── messages.js          # Types et helpers de messages WebSocket
│   └── modules/                  # Modules fonctionnels (extensibles)
│       ├── index.js              # Registre central des modules
│       ├── docker/
│       │   ├── index.js          # Point d'entrée du module Docker
│       │   ├── manager.js         # Gestionnaire Docker (singleton)
│       │   ├── actions.js        # Actions Docker
│       │   └── validator.js      # Validation spécifique Docker
│       └── ssh/
│           ├── index.js          # Point d'entrée du module SSH
│           ├── actions.js        # Actions SSH
│           └── validator.js      # Validation spécifique SSH
├── Dockerfile
├── docker-compose.yml
└── package.json
```

### Architecture modulaire

L'agent utilise une architecture modulaire extensible :

- **Registre de modules** (`modules/index.js`) : Enregistre et charge dynamiquement les modules disponibles
- **Handler générique** (`websocket/handlers.js`) : Route les messages vers le bon module selon le format `module.action`
- **Utilitaires partagés** (`shared/`) : Fonctions communes utilisées par tous les modules (logger, executor, messages)
- **Modules indépendants** : Chaque module expose sa propre interface (`actions`, `validator`)

Pour ajouter un nouveau module :
1. Créer `modules/nouveau-module/` avec `actions.js`, `validator.js`, `index.js`
2. Enregistrer le module dans `modules/index.js`
3. Le module devient automatiquement accessible via `nouveau-module.action`

### Architecture de communication

```
Frontend → WebSocket (port 7080) → Agent → Docker
         ← WebSocket ← Agent ← Docker
```

## 🔒 Sécurité

- Validation de toutes les actions via des validators spécifiques à chaque module (liste blanche)
- Sanitization des paramètres d'entrée (noms de conteneurs, etc.)
- Authentification via token (`token` dans l'URL WebSocket)
- Serveur WebSocket authentifié exposé sur `AGENT_FRONTEND_PORT`
- Exécution en utilisateur non-root dans le conteneur
- Chaque module gère sa propre validation et sanitization

## 📝 Logs

Les logs sont structurés avec les niveaux suivants :
- `error` : Erreurs critiques
- `warn` : Avertissements
- `info` : Informations générales
- `debug` : Informations de débogage

Le niveau de log est configurable via `AGENT_LOG_LEVEL`.

## 🔮 Extensions futures

- Module HAProxy
- Module Fail2Ban
- Module UFW
- Collecte de métriques système (CPU, RAM, Disk)
- Gestion des backups
- Module de gestion des certificats SSL
- Module de monitoring système avancé

> 💡 **Note** : L'architecture modulaire facilite l'ajout de nouveaux modules. Chaque module suit la même structure et s'intègre automatiquement au système de routage.

## 💻 Utilisation depuis le frontend

Le frontend se connecte directement à l'agent via WebSocket, similaire au terminal. Pas besoin de passer par des API routes HTTP/HTTPS, la communication se fait directement via un canal WebSocket ouvert.

### Architecture de communication

```
Frontend → WebSocket → Agent → Docker
         ← WebSocket ← Agent ← Docker
```

L'agent expose maintenant un serveur WebSocket sur le port configuré (`AGENT_FRONTEND_PORT`, par défaut 7080) pour que le frontend puisse s'y connecter directement.

### Configuration frontend

Variables d'environnement Next.js (`.env.local`) :

```env
NEXT_PUBLIC_AGENT_HOST=localhost
NEXT_PUBLIC_AGENT_PORT=7080
NEXT_PUBLIC_AGENT_TOKEN=your-frontend-token
```

En production, utilisez l'IP ou le domaine du serveur :

```env
NEXT_PUBLIC_AGENT_HOST=37.59.118.195
NEXT_PUBLIC_AGENT_PORT=7080
NEXT_PUBLIC_AGENT_TOKEN=your-frontend-token
```

> ℹ️ Le paramètre `token` passé dans l'URL WebSocket doit correspondre à `AGENT_CLIENT_TOKEN` (ou à `AGENT_TOKEN` si aucun token dédié n'est défini).  
> Le paramètre `serverId` est optionnel et sert uniquement d'identifiant de contexte côté agent (logs).

### Exemple : Connexion WebSocket et démarrage d'un conteneur

```javascript
// Connexion WebSocket à l'agent
const agentHost = process.env.NEXT_PUBLIC_AGENT_HOST || "localhost";
const agentPort = process.env.NEXT_PUBLIC_AGENT_PORT || "7080";
const serverId = "server-01"; // Identifiant logique pour les logs côté agent
const agentToken =
  process.env.NEXT_PUBLIC_AGENT_TOKEN || "your-frontend-token";

const wsUrl = `ws://${agentHost}:${agentPort}?token=${encodeURIComponent(
  agentToken
)}&serverId=${encodeURIComponent(serverId)}`;

const socket = new WebSocket(wsUrl);

socket.onopen = () => {
  console.log("Connecté à l'agent");
  
  // Envoyer une commande pour démarrer un conteneur
  const message = {
    id: crypto.randomUUID(),
    action: "docker.start",
    params: {
      container: "webapp-container"
    }
  };
  
  socket.send(JSON.stringify(message));
};

socket.onmessage = (event) => {
  const response = JSON.parse(event.data);
  
  if (response.type === "response" && response.success) {
    console.log("Conteneur démarré:", response.data);
  } else if (response.type === "stream") {
    console.log("Stream:", response.stream, response.data);
  } else if (response.type === "response" && !response.success) {
    console.error("Erreur:", response.error);
  }
};

socket.onerror = (error) => {
  console.error("Erreur WebSocket:", error);
};

socket.onclose = () => {
  console.log("Connexion fermée");
};
```

> Lorsqu'une action ouvre un flux (`docker.logs` avec `follow: true`, `docker.stats` avec `stream: true`), l'agent renvoie d'abord un message `response` avec `mode` indiquant le type de stream, puis des messages `stream` continus jusqu'à la fermeture de la connexion.

### Exemple : Arrêter un conteneur

```javascript
// Depuis une connexion WebSocket déjà établie
const stopMessage = {
  id: crypto.randomUUID(),
  action: "docker.stop",
  params: {
    container: "webapp-container"
  }
};

socket.send(JSON.stringify(stopMessage));
```

### Exemple : Lister les clés SSH

```javascript
// Depuis une connexion WebSocket déjà établie
const sshKeysMessage = {
  id: crypto.randomUUID(),
  action: "ssh.list",
  params: {}
};

socket.send(JSON.stringify(sshKeysMessage));

// Réponse attendue
socket.onmessage = (event) => {
  const response = JSON.parse(event.data);
  
  if (response.type === "response" && response.success) {
    const sshKeys = response.data;
    console.log(`Trouvé ${sshKeys.length} clés SSH uniques`);
    
    sshKeys.forEach(key => {
      console.log(`- Type: ${key.type}, Utilisateurs: ${key.users.join(', ')}`);
      console.log(`  Sources: ${key.sources.join(', ')}`);
    });
  }
};
```

### Exemple complet avec React

```javascript
import { useEffect, useRef, useState } from 'react';

function ContainerControl({ serverId, containerId, token }) {
  const socketRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Connexion WebSocket à l'agent
    const agentHost = process.env.NEXT_PUBLIC_AGENT_HOST || "localhost";
    const agentPort = process.env.NEXT_PUBLIC_AGENT_PORT || "7080";
    const agentToken = process.env.NEXT_PUBLIC_AGENT_TOKEN || token;
    const wsUrl = `ws://${agentHost}:${agentPort}?token=${encodeURIComponent(
      agentToken
    )}&serverId=${encodeURIComponent(serverId)}`;

    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    socket.onmessage = (event) => {
      const response = JSON.parse(event.data);
      
      if (response.type === "response") {
        setLoading(false);
        if (response.success) {
          console.log("Action réussie:", response.data);
        } else {
          setError(response.error || "Erreur inconnue");
        }
      } else if (response.type === "stream") {
        console.log("Stream:", response.stream, response.data);
      }
    };

    socket.onerror = (err) => {
      setError("Erreur de connexion WebSocket");
      setIsConnected(false);
    };

    socket.onclose = () => {
      setIsConnected(false);
    };

    socketRef.current = socket;

    return () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
  }, [serverId, token]);

  const sendCommand = (action: string, params: Record<string, any>) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setError("Non connecté à l'agent");
      return;
    }

    setLoading(true);
    setError(null);

    const message = {
      id: crypto.randomUUID(),
      action,
      params
    };

    socketRef.current.send(JSON.stringify(message));
  };

  const startContainer = () => {
    sendCommand("docker.start", { container: containerId });
  };

  const stopContainer = () => {
    sendCommand("docker.stop", { container: containerId });
  };

  return (
    <div>
      <div>
        {isConnected ? (
          <span className="text-green-400">● Connecté</span>
        ) : (
          <span className="text-red-400">● Déconnecté</span>
        )}
      </div>
      
      <button 
        onClick={startContainer} 
        disabled={loading || !isConnected}
      >
        {loading ? 'Chargement...' : 'Démarrer'}
      </button>
      
      <button 
        onClick={stopContainer} 
        disabled={loading || !isConnected}
      >
        {loading ? 'Chargement...' : 'Arrêter'}
      </button>
      
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  );
}
```

### Exemple avec gestion d'erreurs et reconnexion

```javascript
import { useEffect, useRef, useState } from 'react';

function useAgentWebSocket(serverId: string, token: string) {
  const socketRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 5;

  const connect = () => {
    const agentHost = process.env.NEXT_PUBLIC_AGENT_HOST || "localhost";
    const agentPort = process.env.NEXT_PUBLIC_AGENT_PORT || "7080";
    const agentToken = process.env.NEXT_PUBLIC_AGENT_TOKEN || token;
    const wsUrl = `ws://${agentHost}:${agentPort}?token=${encodeURIComponent(
      agentToken
    )}&serverId=${encodeURIComponent(serverId)}`;

    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      setIsConnected(true);
      reconnectAttemptsRef.current = 0;
    };

    socket.onclose = () => {
      setIsConnected(false);
      
      // Tentative de reconnexion
      if (reconnectAttemptsRef.current < maxReconnectAttempts) {
        reconnectAttemptsRef.current++;
        const delay = Math.min(1000 * reconnectAttemptsRef.current, 5000);
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, delay);
      }
    };

    socket.onerror = () => {
      setIsConnected(false);
    };

    socketRef.current = socket;
  };

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, [serverId, token]);

  const sendMessage = (action: string, params: Record<string, any>) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket non connecté");
    }

    const message = {
      id: crypto.randomUUID(),
      action,
      params
    };

    socketRef.current.send(JSON.stringify(message));
    
    // Retourner une Promise qui se résout avec la réponse
    return new Promise((resolve, reject) => {
      const messageHandler = (event: MessageEvent) => {
        const response = JSON.parse(event.data);
        
        if (response.type === "response" && response.id === message.id) {
          socketRef.current?.removeEventListener('message', messageHandler);
          
          if (response.success) {
            resolve(response.data);
          } else {
            reject(new Error(response.error || "Erreur inconnue"));
          }
        }
      };

      socketRef.current?.addEventListener('message', messageHandler);
      
      // Timeout après 30 secondes
      let timeoutId: NodeJS.Timeout;

      const clearTimeoutOnResponse = (event: MessageEvent) => {
        const response = JSON.parse(event.data);
        if (response.type === "response" && response.id === message.id) {
          clearTimeout(timeoutId);
          socketRef.current?.removeEventListener(
            'message',
            clearTimeoutOnResponse
          );
        }
      };

      socketRef.current?.addEventListener('message', clearTimeoutOnResponse);

      timeoutId = setTimeout(() => {
        socketRef.current?.removeEventListener('message', messageHandler);
        socketRef.current?.removeEventListener(
          'message',
          clearTimeoutOnResponse
        );
        reject(new Error("Timeout"));
      }, 30000);
    });
  };

  return { isConnected, sendMessage };
}

// Utilisation
function ContainerControl({ serverId, containerId, token }) {
  const { isConnected, sendMessage } = useAgentWebSocket(serverId, token);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startContainer = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const result = await sendMessage("docker.start", { container: containerId });
      console.log("Conteneur démarré:", result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  };

  const stopContainer = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const result = await sendMessage("docker.stop", { container: containerId });
      console.log("Conteneur arrêté:", result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div>
        {isConnected ? (
          <span className="text-green-400">● Connecté</span>
        ) : (
          <span className="text-red-400">● Déconnecté</span>
        )}
      </div>
      
      <button onClick={startContainer} disabled={loading || !isConnected}>
        {loading ? 'Chargement...' : 'Démarrer'}
      </button>
      
      <button onClick={stopContainer} disabled={loading || !isConnected}>
        {loading ? 'Chargement...' : 'Arrêter'}
      </button>
      
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  );
}
```

## 🔧 Dépannage

### Le frontend ne peut pas se connecter

1. Vérifier que l'agent est démarré et écoute sur le bon port :
   ```bash
   netstat -tuln | grep 7080
   # ou
   ss -tuln | grep 7080
   ```

2. Vérifier les logs de l'agent :
   ```bash
   docker logs devoups-agent
   # ou
   npm run dev
   ```

3. Vérifier que le token correspond :
   - Le token dans l'URL WebSocket doit correspondre à `AGENT_CLIENT_TOKEN` (ou `AGENT_TOKEN` si non défini)
   - Vérifier les variables d'environnement `NEXT_PUBLIC_AGENT_TOKEN` côté frontend

4. Vérifier les règles de pare-feu :
   - Le port `AGENT_FRONTEND_PORT` doit être accessible depuis le frontend

### Erreur "Invalid token"

- Vérifier que `AGENT_CLIENT_TOKEN` (ou `AGENT_TOKEN`) correspond au token passé dans l'URL WebSocket
- Le token doit être encodé dans l'URL : `?token=${encodeURIComponent(token)}`

### Le serveur WebSocket ne démarre pas

- Vérifier que le port `AGENT_FRONTEND_PORT` n'est pas déjà utilisé
- Vérifier les permissions du processus (doit pouvoir écouter sur le port)

### Module non trouvé

- Vérifier que le module est bien enregistré dans `src/modules/index.js`
- Vérifier les logs au démarrage pour voir les modules chargés
- Redémarrer l'agent après l'ajout d'un nouveau module
- Vérifier que le format de l'action est correct : `module.action` (ex: `docker.list`, `ssh.list`)

## 📄 Licence

ISC

