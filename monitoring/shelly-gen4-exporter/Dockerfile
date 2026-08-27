# monitoring/shelly-gen4-exporter/Dockerfile
#
# Pure HTTP RPC client — stdlib only, nothing to shell out to, so this needs
# nothing beyond the Node runtime itself. Same pattern as wake-proxy/.
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY shelly-gen4-exporter.js ./

RUN useradd --system --create-home --uid 1004 shelly-exporter \
    && chown -R shelly-exporter:shelly-exporter /app
USER shelly-exporter

ENV SHELLY_GEN4_EXPORTER_PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.SHELLY_GEN4_EXPORTER_PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "shelly-gen4-exporter.js"]
