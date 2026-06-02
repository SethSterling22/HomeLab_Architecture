#!/usr/bin/env bash
# scripts/wol/status.sh
# Muestra el estado de todos los nodos del home lab
set -euo pipefail

# ── Colores ──────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; GRAY='\033[0;37m'; NC='\033[0m'
BOLD='\033[1m'

# ── Nodos ─────────────────────────────────────────────────────────
declare -A NODES=(
  [nitro]="192.168.1.10"
  [aery]="192.168.1.20"
  [sram]="192.168.1.30"
  [ocra]="192.168.1.40"
  [xelor]="192.168.1.50"
  [sacro]="192.168.1.60"
)
declare -A NODE_ROLES=(
  [nitro]="Proxmox VE · GPU"
  [aery]="NAS · Synology DSM"
  [sram]="k3s worker · dev"
  [ocra]="k3s worker · AI UI"
  [xelor]="k3s worker · staging (on-demand)"
  [sacro]="k3s worker · monitoring (on-demand)"
)
declare -A NODE_TIER=(
  [nitro]="always"
  [aery]="always"
  [sram]="always"
  [ocra]="always"
  [xelor]="ondemand"
  [sacro]="ondemand"
)

# ── Funciones ─────────────────────────────────────────────────────
ping_node() {
  local ip="$1"
  ping -c1 -W1 "$ip" &>/dev/null 2>&1
}

get_k3s_status() {
  local node="$1"
  if command -v kubectl &>/dev/null; then
    local status
    status=$(kubectl get node "$node" --no-headers 2>/dev/null | awk '{print $2}' || echo "unknown")
    echo "$status"
  else
    echo "n/a"
  fi
}

print_header() {
  echo ""
  echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║           🏠  HomeLab — Estado de Nodos                     ║${NC}"
  echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo -e "  $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo ""
  printf "  ${BOLD}%-10s %-16s %-10s %-12s  %s${NC}\n" "NODO" "IP" "PING" "k3s" "ROL"
  echo -e "  ${GRAY}──────────────────────────────────────────────────────────────${NC}"
}

check_node() {
  local node="$1"
  local ip="${NODES[$node]}"
  local role="${NODE_ROLES[$node]}"
  local tier="${NODE_TIER[$node]}"

  local ping_ok k3s_status ping_icon k3s_icon

  if ping_node "$ip"; then
    ping_ok=true
    ping_icon="${GREEN}● online${NC}"
  else
    ping_ok=false
    if [[ "$tier" == "ondemand" ]]; then
      ping_icon="${YELLOW}○ sleeping${NC}"
    else
      ping_icon="${RED}✗ offline${NC}"
    fi
  fi

  k3s_status=$(get_k3s_status "$node")
  case "$k3s_status" in
    Ready)   k3s_icon="${GREEN}Ready${NC}" ;;
    NotReady) k3s_icon="${YELLOW}NotReady${NC}" ;;
    unknown|n/a) k3s_icon="${GRAY}${k3s_status}${NC}" ;;
    *)       k3s_icon="${GRAY}${k3s_status}${NC}" ;;
  esac

  printf "  ${BLUE}%-10s${NC} %-16s " "$node" "$ip"
  printf "%-26b " "$ping_icon"
  printf "%-24b  " "$k3s_icon"
  echo -e "${GRAY}${role}${NC}"
}

print_ollama_status() {
  local ollama_ip="192.168.1.12"
  local ollama_port="11434"
  echo ""
  echo -e "  ${BOLD}Ollama (Nitro VM)${NC}"
  echo -e "  ${GRAY}──────────────────────────────────────────────────────────────${NC}"
  if curl -sf "http://${ollama_ip}:${ollama_port}/api/tags" &>/dev/null; then
    local models
    models=$(curl -sf "http://${ollama_ip}:${ollama_port}/api/tags" | \
      python3 -c "import sys,json; d=json.load(sys.stdin); [print('   •',m['name']) for m in d.get('models',[])]" 2>/dev/null || echo "   (error leyendo modelos)")
    echo -e "  ${GREEN}● Ollama responde${NC}"
    echo "$models"
  else
    echo -e "  ${YELLOW}○ Ollama no responde en ${ollama_ip}:${ollama_port}${NC}"
  fi
}

# ── Main ──────────────────────────────────────────────────────────
main() {
  print_header

  for node in nitro aery sram ocra xelor sacro; do
    check_node "$node"
  done

  print_ollama_status

  echo ""
  echo -e "  ${GRAY}Tip: ./scripts/wol/wake.sh xelor   — despertar un nodo on-demand${NC}"
  echo ""
}

main "$@"
