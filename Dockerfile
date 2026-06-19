# Backend Dockerfile — Madavision
# Build + runtime en une seule étape, Node 20 Alpine
FROM node:20-alpine

# Installer dumb-init pour gérer les signaux (bonnes pratiques)
RUN apk add --no-cache dumb-init

WORKDIR /app

# Couche de dépendances (cache Docker)
COPY package*.json ./
RUN npm install --production=false

# Copier le reste du code
COPY . .

# Variables d'environnement par défaut (écrasées par le .env ou compose)
ENV NODE_ENV=production \
    PORT=3001

# Port exposé (documentation)
EXPOSE 3001

# Utiliser dumb-init pour que le process reçoive SIGTERM/SIGINT
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Lancer le serveur
CMD ["node", "server.js"]
