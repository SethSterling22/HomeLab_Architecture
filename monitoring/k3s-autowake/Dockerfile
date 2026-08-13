# monitoring/k3s-autowake/Dockerfile
#
# This service only calls `kubectl get pods|nodes` and the Control API's HTTP
# endpoint — it never touches WOL/SSH directly (control-api owns that), so it
# needs kubectl but none of control-api's other tooling (wakeonlan, ssh, etc).
FROM node:20-bookworm-slim

ARG KUBECTL_VERSION=v1.31.0

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
    && curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    && chmod +x /usr/local/bin/kubectl \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# No third-party dependencies: stdlib only, same pattern as the other
# monitoring microservices in this repo.
COPY package.json ./
COPY k3s-autowake.js ./

RUN useradd --system --create-home --uid 1004 autowake \
    && chown -R autowake:autowake /app
USER autowake

ENV K3S_AUTOWAKE_PORT=8095 \
    KUBECONFIG=/home/autowake/.kube/config

EXPOSE 8095

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.K3S_AUTOWAKE_PORT||8095)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "k3s-autowake.js"]
