#!/usr/bin/env bash
# scripts/wol/wake.sh
# Sends a magic packet to one or all cluster nodes.
#
# Usage:
#   ./scripts/wol/wake.sh xelor
#   ./scripts/wol/wake.sh sacro
#   ./scripts/wol/wake.sh sram
#   ./scripts/wol/wake.sh ocra
#   ./scripts/wol/wake.sh all

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

log()  { echo -e "${CYAN}[WOL]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ── Real nodes and MACs ───────────────────────────────────────────
declare -A NODE_MACS=(
  [sram]="d8:9e:f3:89:8a:24"
  [xelor]="88:ae:1d:6c:e4:06"
  [sacro]="68:f7:28:83:d6:77"
  [ocra]="40:49:0f:a7:c4:03"
)
declare -A NODE_IPS=(
  [sram]="100.87.145.104"
  [xelor]="100.92.255.18"
  [sacro]="100.123.227.47"
  [ocra]="192.168.68.100"
)
declare -A NODE_TAGS=(
  [sram]="worker 24/7"
  [ocra]="worker 24/7"
  [xelor]="on-demand · staging"
  [sacro]="on-demand · observability"
)

BROADCAST="192.168.68.255"
WOL_PORT=9
WAIT_TIMEOUT=120   # seconds to wait for a ping response

# ── Functions ─────────────────────────────────────────────────────
check_deps() {
  local missing=()
  for cmd in wakeonlan ping; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    err "Missing dependencies: ${missing[*]}"
    echo "  Install with: sudo apt install wakeonlan iputils-ping"
    exit 1
  fi
}

wake_node() {
  local node="$1"
  local mac="${NODE_MACS[$node]:-}"
  local ip="${NODE_IPS[$node]:-}"

  [[ -z "$ip" ]]  && err "Unknown node: '$node'. Available: ${!NODE_IPS[*]}"
  [[ -z "$mac" ]] && err "MAC not configured for '${node}' — edit NODE_MACS in this script"

  # If it is already up, do nothing
  if ping -c1 -W1 "$ip" &>/dev/null 2>&1; then
    ok "${node} is already up (${ip})"
    return 0
  fi

  log "Sending magic packet to ${BLUE}${node}${NC} (MAC: $mac)"
  wakeonlan -i "$BROADCAST" -p "$WOL_PORT" "$mac"

  log "Waiting for ${node} to respond (max ${WAIT_TIMEOUT}s)..."
  local elapsed=0
  while [[ $elapsed -lt $WAIT_TIMEOUT ]]; do
    if ping -c1 -W1 "$ip" &>/dev/null 2>&1; then
      ok "${node} woke up in ${elapsed}s"
      wait_k3s_ready "$node"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
    printf "."
  done
  echo ""
  warn "${node} did not respond within ${WAIT_TIMEOUT}s — check WOL in the BIOS"
  return 1
}

wait_k3s_ready() {
  local node="$1"
  log "Waiting for ${node} to appear as Ready in k3s..."
  local elapsed=0
  while [[ $elapsed -lt 180 ]]; do
    if kubectl get node "$node" --no-headers 2>/dev/null | grep -q "Ready"; then
      # Uncordon in case it was previously drained
      kubectl uncordon "$node" &>/dev/null 2>&1 || true
      ok "${node} is ready in the k3s cluster"
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  warn "${node} is not Ready in k3s yet — it can join with: ./scripts/k3s/join-worker.sh ${node}"
}

usage() {
  echo ""
  echo -e "  ${BOLD}Usage:${NC} $0 <node|all>"
  echo ""
  echo "  Available nodes:"
  for n in sram ocra xelor sacro; do
    local mac="${NODE_MACS[$n]:-not configured}"
    printf "    ${BLUE}%-8s${NC}  %-18s  %-20s  %s\n" \
      "$n" "${NODE_IPS[$n]}" "$mac" "${NODE_TAGS[$n]}"
  done
  echo ""
  echo "  Examples:"
  echo "    $0 xelor      # Wake Xelor"
  echo "    $0 sacro      # Wake Sacro"
  echo "    $0 all        # Wake all workers"
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────
main() {
  check_deps

  if [[ $# -eq 0 ]]; then
    usage; exit 0
  fi

  local target="$1"

  if [[ "$target" == "all" ]]; then
    log "Waking all workers..."
    for node in sram ocra xelor sacro; do
      [[ -n "${NODE_MACS[$node]}" ]] && wake_node "$node" &
    done
    wait
    ok "All nodes processed"
    echo ""
    kubectl get nodes -o wide
  else
    [[ -z "${NODE_IPS[$target]:-}" ]] && { usage; err "Unknown node: '$target'"; }
    wake_node "$target"
  fi
}

main "$@"
