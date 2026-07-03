#!/usr/bin/env bash
# scripts/k3s/join-worker.sh
# Joins a worker to the k3s cluster after waking it with WOL.
# Usage: ./scripts/k3s/join-worker.sh xelor

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

log()  { echo -e "${CYAN}[k3s]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ── Config ────────────────────────────────────────────────────────
# Tailscale IPs are used so the join survives LAN reconfigurations.
declare -A WORKER_IPS=(
  [sram]="100.87.145.104"
  [xelor]="100.92.255.18"
  [sacro]="100.123.227.47"
  [ocra]="100.107.52.17"
)
K3S_MASTER_IP="192.168.68.10"      # Sadida — k3s control-plane (runs on the Proxmox host)
K3S_VERSION="v1.35.5+k3s1"
SSH_USER="${SSH_USER:-seth}"
K3S_TOKEN_FILE="${HOME}/.homelab/k3s-token"  # cached locally on first setup

# ── Main ──────────────────────────────────────────────────────────
main() {
  local node="${1:-}"
  [[ -z "$node" ]] && { echo "Usage: $0 <node>"; exit 1; }

  local ip="${WORKER_IPS[$node]:-}"
  [[ -z "$ip" ]] && err "Unknown node: '$node'. Available: ${!WORKER_IPS[*]}"

  # Fetch the k3s token from the master if it is not cached
  if [[ ! -f "$K3S_TOKEN_FILE" ]]; then
    log "Fetching the k3s token from the master..."
    mkdir -p "$(dirname "$K3S_TOKEN_FILE")"
    ssh "${SSH_USER}@${K3S_MASTER_IP}" "sudo cat /var/lib/rancher/k3s/server/node-token" > "$K3S_TOKEN_FILE"
    chmod 600 "$K3S_TOKEN_FILE"
  fi

  local token
  token=$(cat "$K3S_TOKEN_FILE")

  log "Installing the k3s agent on ${BLUE}${node}${NC} (${ip})..."
  # shellcheck disable=SC2087
  ssh "${SSH_USER}@${ip}" bash << EOF
set -e
# If already installed, just restart it
if systemctl is-active --quiet k3s-agent 2>/dev/null; then
  echo "k3s-agent was already active, restarting..."
  sudo systemctl restart k3s-agent
  exit 0
fi

# Fresh install
curl -sfL https://get.k3s.io | \\
  INSTALL_K3S_VERSION="${K3S_VERSION}" \\
  K3S_TOKEN="${token}" \\
  K3S_URL="https://${K3S_MASTER_IP}:6443" \\
  sh -s - agent \\
    --node-name "${node}"

echo "k3s-agent installed and starting..."
EOF

  log "Waiting for ${node} to become Ready in the cluster..."
  local elapsed=0
  while [[ $elapsed -lt 120 ]]; do
    if kubectl get node "$node" --no-headers 2>/dev/null | grep -q "Ready"; then
      ok "${node} is ready in the cluster"

      # Label as on-demand
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
  err "${node} did not register within 120s — check connectivity and the token"
}

main "$@"
