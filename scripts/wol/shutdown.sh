#!/usr/bin/env bash
# scripts/wol/shutdown.sh
# Apaga uno o todos los nodos del clúster de forma segura
# Drena el nodo en k3s antes de apagar para evitar pods colgados
#
# Uso:
#   ./scripts/wol/shutdown.sh xelor
#   ./scripts/wol/shutdown.sh sacro
#   ./scripts/wol/shutdown.sh sram
#   ./scripts/wol/shutdown.sh ocra
#   ./scripts/wol/shutdown.sh all
#   ./scripts/wol/shutdown.sh all --skip-drain   # apagado rápido sin drain
set -euo pipefail

# ── Colores ──────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

log()  { echo -e "${CYAN}[shutdown]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ── Nodos del clúster ─────────────────────────────────────────────
# Todos los workers — edita SSH_USER si tu usuario es diferente en algún nodo
declare -A NODE_IPS=(
  [ocra]="192.168.68.100"
  [sram]="100.87.145.104"
  [xelor]="100.92.255.18"
  [sacro]="100.123.227.47"
)
declare -A NODE_USERS=(
  [ocra]="seth"
  [sram]="seth"
  [xelor]="seth"
  [sacro]="seth"
)
# Nodos on-demand (se drenan siempre antes de apagar)
ON_DEMAND_NODES=(xelor sacro)

# Sadida es el master — no se apaga con este script
MASTER_NODE="sadida"

# ── Flags ─────────────────────────────────────────────────────────
SKIP_DRAIN=false

# ── Funciones ─────────────────────────────────────────────────────
check_deps() {
  for cmd in ssh kubectl; do
    command -v "$cmd" &>/dev/null || err "Dependencia faltante: $cmd"
  done
}

is_ondemand() {
  local node="$1"
  for n in "${ON_DEMAND_NODES[@]}"; do
    [[ "$n" == "$node" ]] && return 0
  done
  return 1
}

node_is_up() {
  local ip="$1"
  ping -c1 -W2 "$ip" &>/dev/null 2>&1
}

k3s_node_ready() {
  local node="$1"
  kubectl get node "$node" --no-headers 2>/dev/null | grep -q "Ready"
}

drain_node() {
  local node="$1"

  if ! k3s_node_ready "$node"; then
    warn "${node} no está en el clúster k3s — saltando drain"
    return 0
  fi

  log "Drenando ${BLUE}${node}${NC} (moviendo pods a otros workers)..."
  kubectl drain "$node" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --timeout=60s \
    --grace-period=30 2>/dev/null || warn "Drain completado con advertencias en ${node}"

  ok "${node} drenado"
}

shutdown_node() {
  local node="$1"
  local ip="${NODE_IPS[$node]:-}"
  local user="${NODE_USERS[$node]:-seth}"

  [[ -z "$ip" ]] && err "Nodo desconocido: '$node'. Disponibles: ${!NODE_IPS[*]}"

  if ! node_is_up "$ip"; then
    warn "${node} (${ip}) no responde al ping — puede que ya esté apagado"
    return 0
  fi

  # Drenar si es on-demand o si no se saltó el drain
  if [[ "$SKIP_DRAIN" == "false" ]]; then
    drain_node "$node"
  else
    warn "Saltando drain en ${node} (--skip-drain activo)"
  fi

  log "Apagando ${BLUE}${node}${NC} (${ip})..."
  ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
    "${user}@${ip}" "sudo shutdown -h now" 2>/dev/null || true

  # Esperar a que deje de responder
  local elapsed=0
  while [[ $elapsed -lt 30 ]]; do
    if ! ping -c1 -W1 "$ip" &>/dev/null 2>&1; then
      ok "${node} apagado"
      # Marcar como no-schedulable en k3s
      kubectl cordon "$node" &>/dev/null 2>&1 || true
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  warn "${node} tardó más de lo esperado en apagarse"
}

usage() {
  echo ""
  echo -e "  ${BOLD}Uso:${NC} $0 <nodo|all> [--skip-drain]"
  echo ""
  echo "  Nodos disponibles:"
  for n in ocra sram xelor sacro; do
    local tag=""
    is_ondemand "$n" && tag=" ${YELLOW}(on-demand)${NC}"
    printf "    ${BLUE}%-8s${NC} →  %s%b\n" "$n" "${NODE_IPS[$n]}" "$tag"
  done
  echo ""
  echo "  Opciones:"
  echo "    --skip-drain    Apaga sin drenar pods (apagado de emergencia)"
  echo ""
  echo "  Ejemplos:"
  echo "    $0 xelor                 # Drenar y apagar Xelor"
  echo "    $0 all                   # Drenar y apagar todos los workers"
  echo "    $0 all --skip-drain      # Apagar todo sin mover pods"
  echo ""
  echo -e "  ${YELLOW}Nota:${NC} Sadida (master) no se puede apagar con este script."
  echo ""
}

confirm() {
  local target="$1"
  echo ""
  echo -e "  ${YELLOW}⚠️  Vas a apagar: ${BOLD}${target}${NC}"
  [[ "$SKIP_DRAIN" == "true" ]] && echo -e "  ${RED}⚠️  Sin drain — los pods activos se interrumpirán${NC}"
  echo ""
  read -r -p "  ¿Confirmar? [y/N] " response
  [[ "$response" =~ ^[yY]$ ]] || { echo "  Cancelado."; exit 0; }
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────
main() {
  check_deps

  if [[ $# -eq 0 ]]; then
    usage; exit 0
  fi

  local target="$1"
  shift

  # Parsear flags adicionales
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --skip-drain) SKIP_DRAIN=true; shift ;;
      *) err "Argumento desconocido: $1" ;;
    esac
  done

  # Proteger el master
  if [[ "$target" == "$MASTER_NODE" ]]; then
    err "No se puede apagar el master '${MASTER_NODE}' con este script."
  fi

  if [[ "$target" == "all" ]]; then
    confirm "todos los workers (ocra, sram, xelor, sacro)"
    log "Apagando todos los workers..."
    # Primero drenar todos en paralelo, luego apagar secuencialmente
    if [[ "$SKIP_DRAIN" == "false" ]]; then
      for node in ocra sram xelor sacro; do
        drain_node "$node" &
      done
      wait
    fi
    for node in ocra sram xelor sacro; do
      SKIP_DRAIN=true shutdown_node "$node"
    done
    ok "Todos los workers apagados"
  else
    [[ -z "${NODE_IPS[$target]:-}" ]] && { usage; err "Nodo desconocido: '$target'"; }
    confirm "$target"
    shutdown_node "$target"
  fi
}

main "$@"
