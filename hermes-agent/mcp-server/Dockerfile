FROM node:20-alpine

# Herramientas de shell que están en la allowlist del server
RUN apk add --no-cache \
    bash curl git jq python3 py3-pip \
    coreutils findutils grep

# Usuario no-root para el proceso MCP
RUN addgroup -g 1001 hermes && adduser -u 1001 -G hermes -s /bin/sh -D hermes

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# /workspace se montará como bind mount desde el host (o PVC en k8s)
RUN mkdir -p /workspace/output && chown -R hermes:hermes /workspace

USER hermes

ENV WORKSPACE_ROOT=/workspace
ENV NODE_ENV=production

CMD ["node", "server.js"]
