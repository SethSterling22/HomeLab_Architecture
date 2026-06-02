#!/usr/bin/env bash
# scripts/k3s/join-worker.sh
# Une un worker al clúster k3s después de encenderlo con WOL
# Uso: ./scripts/k3s/join-worker.sh xelor
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

log()  { echo -e "${CYAN}[k3s]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ── Config ────────────────────────────────────────────────────────
declare -A WORKER_IPS=(
  [xelor]="192.168.1.50"
  [sacro]="192.168.1.60"
)
K3S_MASTER_IP="192.168.1.11"       # IP de la VM master en Nitro
K3S_VERSION="v1.29.4+k3s1"
K3S_TOKEN_FILE="${HOME}/.homelab/k3s-token"  # guardado localmente en el primer setup

# ── Main ──────────────────────────────────────────────────────────
main() {
  local node="${1:-}"
  [[ -z "$node" ]] && { echo "Uso: $0 <nodo>"; exit 1; }

  local ip="${WORKER_IPS[$node]:-}"
  [[ -z "$ip" ]] && err "Nodo desconocido: '$node'"

  # Obtener token k3s del master si no está en cache
  if [[ ! -f "$K3S_TOKEN_FILE" ]]; then
    log "Obteniendo token k3s del master..."
    mkdir -p "$(dirname "$K3S_TOKEN_FILE")"
    ssh "ubuntu@${K3S_MASTER_IP}" "sudo cat /var/lib/rancher/k3s/server/node-token" > "$K3S_TOKEN_FILE"
    chmod 600 "$K3S_TOKEN_FILE"
  fi

  local token
  token=$(cat "$K3S_TOKEN_FILE")

  log "Instalando k3s agent en ${BLUE}${node}${NC} (${ip})..."
  # shellcheck disable=SC2087
  ssh "ubuntu@${ip}" bash << EOF
set -e
# Si ya está instalado, solo reiniciar
if systemctl is-active --quiet k3s-agent 2>/dev/null; then
  echo "k3s-agent ya estaba activo, reiniciando..."
  sudo systemctl restart k3s-agent
  exit 0
fi

# Instalación fresca
curl -sfL https://get.k3s.io | \\
  INSTALL_K3S_VERSION="${K3S_VERSION}" \\
  K3S_TOKEN="${token}" \\
  K3S_URL="https://${K3S_MASTER_IP}:6443" \\
  sh -s - agent \\
    --node-name "${node}"

echo "k3s-agent instalado y arrancando..."
EOF

  log "Esperando que ${node} aparezca como Ready en el clúster..."
  local elapsed=0
  while [[ $elapsed -lt 120 ]]; do
    if kubectl get node "$node" --no-headers 2>/dev/null | grep -q "Ready"; then
      ok "${node} está listo en el clúster"

      # Etiquetar como on-demand
      kubectl label node "$node" homelab/on-demand=true --overwrite &>/dev/null
      kubectl label node "$node" homelab/always-on=false --overwrite &>/dev/null

      echo ""
      kubectl get node "$node" -o wide
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
    printf "."
  done
  echo ""
  err "${node} no se registró en 120s — verifica conectividad y el token"
}

main "$@"
