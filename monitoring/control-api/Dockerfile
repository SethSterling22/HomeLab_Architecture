# monitoring/control-api/Dockerfile
#
# The Control API shells out to scripts/wol/*, so the image must carry the
# tools those scripts expect:
#   wakeonlan  - sends the magic packet
#   iputils-ping - the scripts poll a node until it answers
#   openssh-client - shutdown.sh connects to the node to power it off
#   kubectl    - shutdown.sh drains the node from k3s first
#   bash       - the scripts use bash-only features (associative arrays)
#   netbase    - NOT optional. wakeonlan is a Perl script that resolves the
#     UDP protocol number via getprotobyname('udp'), which reads /etc/protocols
#     — a file only netbase provides. Without it, wakeonlan warns
#     "Use of uninitialized value $proto in socket" and the magic packet is
#     never actually sent. node:20-bookworm-slim doesn't include it, and
#     --no-install-recommends below means it won't be pulled in implicitly
#     just because wakeonlan is installed.
FROM node:20-bookworm-slim

ARG KUBECTL_VERSION=v1.31.0

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      netbase \
      wakeonlan \
      iputils-ping \
      openssh-client \
      ca-certificates \
      curl \
    && curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    && chmod +x /usr/local/bin/kubectl \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# No third-party dependencies: the service uses only the Node standard library,
# so there is no npm install step and no lockfile to drift.
COPY package.json ./
COPY server.js ./

# Run as a non-root user. Note this user still needs a readable SSH key and
# kubeconfig mounted in to be able to drain and power off nodes.
RUN useradd --system --create-home --uid 1001 control \
    && chown -R control:control /app
USER control

ENV CONTROL_API_PORT=8090 \
    CONTROL_API_SCRIPTS_DIR=/opt/homelab/scripts/wol

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.CONTROL_API_PORT||8090)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
