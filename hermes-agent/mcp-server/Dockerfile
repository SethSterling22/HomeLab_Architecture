FROM node:20-alpine

# Shell tools that are in the server's allowlist
RUN apk add --no-cache \
    bash curl git jq python3 py3-pip \
    coreutils findutils grep

# Non-root user for the MCP process
RUN addgroup -g 1001 hermes && adduser -u 1001 -G hermes -s /bin/sh -D hermes

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# gateway.js  → HTTP server on :8080 (used by n8n / Docker Compose / k8s)
# server.js   → native stdio MCP server (optional, for MCP clients)
COPY gateway.js server.js ./

# /workspace is mounted as a bind mount from the host (or a PVC in k8s)
RUN mkdir -p /workspace/output && chown -R hermes:hermes /workspace

USER hermes

ENV WORKSPACE_ROOT=/workspace
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# The default artifact is the HTTP gateway.
# To run the stdio MCP server instead: docker run ... node server.js
CMD ["node", "gateway.js"]
