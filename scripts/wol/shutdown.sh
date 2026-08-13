#!/usr/bin/env bash
# scripts/wol/shutdown.sh
# Safely powers off one or all cluster nodes.
# Drains the node from k3s before powering off to avoid stuck pods.
#
# Usage:
#   ./scripts/wol/shutdown.sh xelor
#   ./scripts/wol/shutdown.sh sacro
#   ./scripts/wol/shutdown.sh sram
#   ./scripts/wol/shutdown.sh ocra
#   ./scripts/wol/shutdown.sh aery
#   ./scripts/wol/shutdown.sh all
#   ./scripts/wol/shutdown.sh all --skip-drain   # fast shutdown without draining
#   ./scripts/wol/shutdown.sh xelor --yes        # non-interactive (used by the Control API)
#
# Note: "all" deliberately does NOT include aery (see ON_DEMAND/MASTER-style
# exclusion below) — same reasoning as Ocra being excluded from "all": a
# storage/Nextcloud node should never go down as a side effect of a blanket
# sweep, only when explicitly named or when idle-shutdown decides to.

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

log()  { echo -e "${CYAN}[shutdown]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ── Cluster nodes ─────────────────────────────────────────────────
# All workers — edit SSH_USER if your user differs on any node.
declare -A NODE_IPS=(
  [ocra]="100.107.52.17"
  [sram]="100.87.145.104"
  [xelor]="100.92.255.18"
  [sacro]="100.123.227.47"
  # MagicDNS hostname (not a raw Tailscale IP, unlike the others above):
  # this repo has no recorded Tailscale IP for Aery. Swap in the real IP
  # from `tailscale status` if you want it consistent with the rest.
  [aery]="aery.stegosaurus-panga.ts.net"
)
declare -A NODE_USERS=(
  [ocra]="seth"
  [sram]="seth"
  [xelor]="seth"
  [sacro]="seth"
  [aery]="seth"
)
# On-demand nodes (always drained before powering off)
ON_DEMAND_NODES=(xelor sacro)

# Sadida is the master — it is not powered off by this script
MASTER_NODE="sadida"

# ── Flags ─────────────────────────────────────────────────────────
SKIP_DRAIN=false
# ASSUME_YES skips the interactive prompt. Required when this script is
# invoked by a non-interactive caller such as monitoring/control-api,
# which has no TTY to answer the prompt.
ASSUME_YES=false

# ── Functions ─────────────────────────────────────────────────────
check_deps() {
  for cmd in ssh kubectl; do
    command -v "$cmd" &>/dev/null || err "Missing dependency: $cmd"
  done
}

is_ondemand() {
  local node="$1"
  # Pre-existing bug fixed here: this loop used to reuse the bare name `n`,
  # which is NOT function-local in bash unless declared so. That silently
  # clobbered any caller's own `n` loop variable (e.g. usage()'s `for n in
  # ocra sram xelor sacro aery`), corrupting its output. `local candidate`
  # makes this function's loop variable actually local.
  local candidate
  for candidate in "${ON_DEMAND_NODES[@]}"; do
    [[ "$candidate" == "$node" ]] && return 0
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
    warn "${node} is not in the k3s cluster — skipping drain"
    return 0
  fi

  log "Draining ${BLUE}${node}${NC} (moving pods to other workers)..."
  kubectl drain "$node" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --timeout=60s \
    --grace-period=30 2>/dev/null || warn "Drain completed with warnings on ${node}"

  ok "${node} drained"
}

shutdown_node() {
  local node="$1"
  local ip="${NODE_IPS[$node]:-}"
  local user="${NODE_USERS[$node]:-seth}"

  [[ -z "$ip" ]] && err "Unknown node: '$node'. Available: ${!NODE_IPS[*]}"

  if ! node_is_up "$ip"; then
    warn "${node} (${ip}) is not responding to ping — it may already be off"
    return 0
  fi

  # Drain if on-demand or if drain was not skipped
  if [[ "$SKIP_DRAIN" == "false" ]]; then
    drain_node "$node"
  else
    warn "Skipping drain on ${node} (--skip-drain active)"
  fi

  log "Powering off ${BLUE}${node}${NC} (${ip})..."
    if [[ "$node" == "sacro" || "$node" == "aery" ]]; then
      # Exemption for hardware that does not reliably support WOL from a
      # full ACPI poweroff (S5) — confirmed on Sacro, and now also on Aery
      # (an Acer Aspire E1-422 laptop): `ethtool` doesn't even report
      # Supports/Wake-on lines for its NIC and refuses `ethtool -s wol g`
      # with "Operation not supported", and a real shutdown+WOL round-trip
      # failed to wake it, despite "Wake on LAN" being enabled in the BIOS.
      # This is a common laptop limitation: the BIOS toggle covers waking
      # from suspend (S3), not a fully powered-off board (S5), because
      # consumer/laptop boards often don't route standby power to the NIC
      # when fully off the way a desktop ATX PSU does. `systemctl suspend`
      # keeps enough of the board powered for the NIC to still catch a
      # magic packet.
      ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
        "${user}@${ip}" "sudo systemctl suspend"
    else
      ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
        "${user}@${ip}" "sudo shutdown -h now"
    fi

  # Wait for it to stop responding
  local elapsed=0
  while [[ $elapsed -lt 30 ]]; do
    if ! ping -c1 -W1 "$ip" &>/dev/null 2>&1; then
      ok "${node} powered off"
      # Mark as unschedulable in k3s
      kubectl cordon "$node" &>/dev/null 2>&1 || true
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  warn "${node} took longer than expected to power off"
}

usage() {
  echo ""
  echo -e "  ${BOLD}Usage:${NC} $0 <node|all> [--skip-drain]"
  echo ""
  echo "  Available nodes:"
  for n in ocra sram xelor sacro aery; do
    local tag=""
    is_ondemand "$n" && tag=" ${YELLOW}(on-demand)${NC}"
    [[ "$n" == "aery" ]] && tag=" ${YELLOW}(idle-managed; excluded from 'all')${NC}"
    printf "    ${BLUE}%-8s${NC} →  %s%b\n" "$n" "${NODE_IPS[$n]}" "$tag"
  done
  echo ""
  echo "  Options:"
  echo "    --skip-drain    Power off without draining pods (emergency shutdown)"
  echo "    --yes, -y       Do not prompt for confirmation (non-interactive callers)"
  echo ""
  echo "  Examples:"
  echo "    $0 xelor                 # Drain and power off Xelor"
  echo "    $0 all                   # Drain and power off all workers"
  echo "    $0 all --skip-drain      # Power everything off without moving pods"
  echo ""
  echo -e "  ${YELLOW}Note:${NC} Sadida (master) cannot be powered off with this script."
  echo ""
}

confirm() {
  local target="$1"

  if [[ "$ASSUME_YES" == "true" ]]; then
    warn "Non-interactive mode (--yes): powering off ${target} without prompting"
    return 0
  fi

  echo ""
  echo -e "  ${YELLOW}⚠️  You are about to power off: ${BOLD}${target}${NC}"
  [[ "$SKIP_DRAIN" == "true" ]] && echo -e "  ${RED}⚠️  No drain — active pods will be interrupted${NC}"
  echo ""
  read -r -p "  Confirm? [y/N] " response
  [[ "$response" =~ ^[yY]$ ]] || { echo "  Cancelled."; exit 0; }
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

  # Parse additional flags
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --skip-drain) SKIP_DRAIN=true; shift ;;
      --yes|-y)     ASSUME_YES=true; shift ;;
      *) err "Unknown argument: $1" ;;
    esac
  done

  # Protect the master
  if [[ "$target" == "$MASTER_NODE" ]]; then
    err "Cannot power off the master '${MASTER_NODE}' with this script."
  fi

  if [[ "$target" == "all" ]]; then
    confirm "all workers (ocra, sram, xelor, sacro)"
    log "Powering off all workers..."
    # First drain all in parallel, then power off sequentially
    if [[ "$SKIP_DRAIN" == "false" ]]; then
      for node in ocra sram xelor sacro; do
        drain_node "$node" &
      done
      wait
    fi
    for node in sram xelor sacro; do # Skip Ocra since it does not support Wake-on-LAN
      shutdown_node "$node"
    done
    ok "All workers powered off"
  else
    [[ -z "${NODE_IPS[$target]:-}" ]] && { usage; err "Unknown node: '$target'"; }
    confirm "$target"
    shutdown_node "$target"
  fi
}

main "$@"
