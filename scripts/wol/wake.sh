#!/usr/bin/env bash
# scripts/wol/wake.sh
# Envía magic packet a uno o todos los nodos on-demand
# Uso:
#   ./scripts/wol/wake.sh xelor
#   ./scripts/wol/wake.sh sacro
#   ./scripts/wol/wake.sh all
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONFIG_FILE="${PROJECT_ROOT}/ansible/inventory/hosts.yml"

# ── Colores ──────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

# ── Nodos on-demand y sus MACs ───────────────────────────────────
# Edita estas variables si no usas el inventario de Ansible
declare -A NODES=(
  [xelor]="AA:BB:CC:DD:EE:01"
  [sacro]="AA:BB:CC:DD:EE:02"
)
declare -A NODE_IPS=(
  [xelor]="192.168.1.50"
  [sacro]="192.168.1.60"
)
BROADCAST="192.168.1.255"
WOL_PORT=9
WAIT_TIMEOUT=120   # segundos esperando que el nodo responda

# ── Funciones ─────────────────────────────────────────────────────
log()  { echo -e "${CYAN}[WOL]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; }

check_deps() {
  local missing=()
  for cmd in wakeonlan ping; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    err "Dependencias faltantes: ${missing[*]}"
    echo "  Instala con: sudo apt install wakeonlan iputils-ping"
    exit 1
  fi
}

wake_node() {
  local node="$1"
  local mac="${NODES[$node]:-}"
  local ip="${NODE_IPS[$node]:-}"

  if [[ -z "$mac" ]]; then
    err "Nodo desconocido: '$node'. Disponibles: ${!NODES[*]}"
    exit 1
  fi

  log "Enviando magic packet a ${BLUE}${node}${NC} (MAC: $mac, IP: $ip)..."
  wakeonlan -i "$BROADCAST" -p "$WOL_PORT" "$mac"

  log "Esperando que ${node} responda (máx ${WAIT_TIMEOUT}s)..."
  local elapsed=0
  while [[ $elapsed -lt $WAIT_TIMEOUT ]]; do
    if ping -c1 -W1 "$ip" &>/dev/null 2>&1; then
      ok "${node} está despierto y responde en ${elapsed}s"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
    printf "."
  done
  echo ""
  warn "${node} no respondió en ${WAIT_TIMEOUT}s — puede tardar más o WOL no está configurado"
  return 1
}

wait_k3s_join() {
  local node="$1"
  log "Esperando que ${node} se una al clúster k3s..."
  local elapsed=0
  while [[ $elapsed -lt 180 ]]; do
    if kubectl get node "$node" --no-headers 2>/dev/null | grep -q "Ready"; then
      ok "${node} se unió al clúster k3s"
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  warn "${node} aún no aparece como Ready en k3s — puede necesitar unirse manualmente"
}

usage() {
  echo ""
  echo "  Uso: $0 <nodo|all>"
  echo ""
  echo "  Nodos disponibles:"
  for n in "${!NODES[@]}"; do
    echo "    ${BLUE}${n}${NC}  →  ${NODE_IPS[$n]}  (${NODES[$n]})"
  done
  echo ""
  echo "  Ejemplos:"
  echo "    $0 xelor          # Despertar solo Xelor"
  echo "    $0 sacro          # Despertar solo Sacro"
  echo "    $0 all            # Despertar todos los nodos on-demand"
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
    log "Despertando todos los nodos on-demand..."
    for node in "${!NODES[@]}"; do
      wake_node "$node" || true
    done
    # Esperar joins en paralelo
    for node in "${!NODES[@]}"; do
      wait_k3s_join "$node" &
    done
    wait
    ok "Todos los nodos procesados"
  else
    wake_node "$target"
    wait_k3s_join "$target"
  fi
}

main "$@"
