#!/usr/bin/env bash
# scripts/wol/wake.sh
# Envía magic packet a uno o todos los nodos del clúster
#
# Uso:
#   ./scripts/wol/wake.sh xelor
#   ./scripts/wol/wake.sh sacro
#   ./scripts/wol/wake.sh sram
#   ./scripts/wol/wake.sh ocra
#   ./scripts/wol/wake.sh all
set -euo pipefail

# ── Colores ──────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

log()  { echo -e "${CYAN}[WOL]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ── Nodos y MACs reales ───────────────────────────────────────────
declare -A NODE_MACS=(
  [sram]="d8:9e:f3:89:8a:24"
  [xelor]="88:ae:1d:6c:e4:06"
  [sacro]="68:f7:28:83:d6:77"
  [ocra]=""    # añadir MAC cuando se configure WOL en Ocra
)
declare -A NODE_IPS=(
  [sram]="192.168.68.108"
  [xelor]="192.168.68.114"
  [sacro]="192.168.68.115"
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
WAIT_TIMEOUT=120   # segundos esperando ping response

# ── Funciones ─────────────────────────────────────────────────────
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
  local mac="${NODE_MACS[$node]:-}"
  local ip="${NODE_IPS[$node]:-}"

  [[ -z "$ip" ]]  && err "Nodo desconocido: '$node'. Disponibles: ${!NODE_IPS[*]}"
  [[ -z "$mac" ]] && err "MAC no configurada para '${node}' — edita NODE_MACS en este script"

  # Si ya está encendido, no hacer nada
  if ping -c1 -W1 "$ip" &>/dev/null 2>&1; then
    ok "${node} ya está encendido (${ip})"
    return 0
  fi

  log "Enviando magic packet a ${BLUE}${node}${NC} (MAC: $mac)"
  wakeonlan -i "$BROADCAST" -p "$WOL_PORT" "$mac"

  log "Esperando que ${node} responda (máx ${WAIT_TIMEOUT}s)..."
  local elapsed=0
  while [[ $elapsed -lt $WAIT_TIMEOUT ]]; do
    if ping -c1 -W1 "$ip" &>/dev/null 2>&1; then
      ok "${node} despierto en ${elapsed}s"
      wait_k3s_ready "$node"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
    printf "."
  done
  echo ""
  warn "${node} no respondió en ${WAIT_TIMEOUT}s — verifica WOL en BIOS"
  return 1
}

wait_k3s_ready() {
  local node="$1"
  log "Esperando que ${node} aparezca como Ready en k3s..."
  local elapsed=0
  while [[ $elapsed -lt 180 ]]; do
    if kubectl get node "$node" --no-headers 2>/dev/null | grep -q "Ready"; then
      # Descordon por si fue apagado previamente con drain
      kubectl uncordon "$node" &>/dev/null 2>&1 || true
      ok "${node} listo en el clúster k3s"
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  warn "${node} no aparece como Ready en k3s — puede unirse con: ./scripts/k3s/join-worker.sh ${node}"
}

usage() {
  echo ""
  echo -e "  ${BOLD}Uso:${NC} $0 <nodo|all>"
  echo ""
  echo "  Nodos disponibles:"
  for n in sram ocra xelor sacro; do
    local mac="${NODE_MACS[$n]:-no configurada}"
    printf "    ${BLUE}%-8s${NC}  %-18s  %-20s  %s\n" \
      "$n" "${NODE_IPS[$n]}" "$mac" "${NODE_TAGS[$n]}"
  done
  echo ""
  echo "  Ejemplos:"
  echo "    $0 xelor      # Despertar Xelor"
  echo "    $0 sacro      # Despertar Sacro"
  echo "    $0 all        # Despertar todos los workers"
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
    log "Despertando todos los workers..."
    for node in sram ocra xelor sacro; do
      [[ -n "${NODE_MACS[$node]}" ]] && wake_node "$node" &
    done
    wait
    ok "Todos los nodos procesados"
    echo ""
    kubectl get nodes -o wide
  else
    [[ -z "${NODE_IPS[$target]:-}" ]] && { usage; err "Nodo desconocido: '$target'"; }
    wake_node "$target"
  fi
}

main "$@"
