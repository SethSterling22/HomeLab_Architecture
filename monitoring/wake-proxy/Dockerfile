# monitoring/wake-proxy/Dockerfile
#
# Pure HTTP reverse proxy + Control API client — stdlib only, nothing to
# shell out to, so this needs nothing beyond the Node runtime itself.
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY wake-proxy.js ./

RUN useradd --system --create-home --uid 1003 wake-proxy \
    && chown -R wake-proxy:wake-proxy /app
USER wake-proxy

ENV WAKE_PROXY_PORT=8093 \
    WAKE_PROXY_ADMIN_PORT=8094

EXPOSE 8093 8094

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.WAKE_PROXY_ADMIN_PORT||8094)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "wake-proxy.js"]
