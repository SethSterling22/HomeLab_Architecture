# monitoring/idle-shutdown/Dockerfile
#
# This daemon only ever talks HTTP to Prometheus and the Control API — no
# SSH, no WOL, no shelling out — so unlike control-api it needs nothing
# beyond the Node runtime itself.
FROM node:20-bookworm-slim

WORKDIR /app

# No third-party dependencies: stdlib http only, so no npm install and no
# lockfile to drift (same rationale as control-api).
COPY package.json ./
COPY idle-shutdown.js ./

RUN useradd --system --create-home --uid 1002 idle-shutdown \
    && chown -R idle-shutdown:idle-shutdown /app
USER idle-shutdown

ENV IDLE_SHUTDOWN_PORT=8092

EXPOSE 8092

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.IDLE_SHUTDOWN_PORT||8092)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "idle-shutdown.js"]
