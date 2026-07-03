#!/usr/bin/env bash
# scripts/ai/pull-models.sh
# Pulls the AI models into Ollama (runs locally on Sadida, host service with GPU).
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

# Ollama runs locally on Sadida (RTX 3050). Reachable over Tailscale MagicDNS or LAN IP.
OLLAMA_HOST="${OLLAMA_HOST:-http://sadida.stegosaurus-panga.ts.net:11434}"

log()  { echo -e "${CYAN}[Ollama]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ── Models to install ─────────────────────────────────────────────
# These are the two models the Hermes/n8n stack expects:
# - qwen3:1.7b    small, fast — intent classifier
# - qwen3.5:4b    main conversational agent (chat / simple queries)
# Adjust to the VRAM available on your GPU.
MODELS=(
  "qwen3:1.7b"
  "qwen3.5:4b"
)

check_ollama() {
  log "Checking Ollama at ${OLLAMA_HOST}..."
  if ! curl -sf "${OLLAMA_HOST}/api/tags" &>/dev/null; then
    err "Cannot connect to Ollama at ${OLLAMA_HOST}"
  fi
  ok "Ollama is responding"
}

list_installed() {
  curl -sf "${OLLAMA_HOST}/api/tags" | \
    python3 -c "
import sys, json
d = json.load(sys.stdin)
models = [m['name'] for m in d.get('models', [])]
print('\n'.join(models))
" 2>/dev/null || true
}

pull_model() {
  local model="$1"
  local installed
  installed=$(list_installed)

  if echo "$installed" | grep -qx "$model"; then
    ok "Model '${model}' already installed — skipping"
    return 0
  fi

  log "Pulling ${BLUE}${model}${NC}..."
  # Use streaming to show progress
  curl -sf -X POST "${OLLAMA_HOST}/api/pull" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"${model}\", \"stream\": true}" | \
    while IFS= read -r line; do
      status=$(echo "$line" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('status',''))" 2>/dev/null || echo "")
      if [[ -n "$status" ]]; then
        printf "\r  ${CYAN}→${NC} %-60s" "$status"
      fi
    done
  echo ""
  ok "Model '${model}' ready"
}

print_summary() {
  echo ""
  log "Models installed in Ollama:"
  curl -sf "${OLLAMA_HOST}/api/tags" | \
    python3 -c "
import sys, json
d = json.load(sys.stdin)
for m in d.get('models', []):
    size_gb = m.get('size', 0) / (1024**3)
    print(f'  • {m[\"name\"]:<35} {size_gb:.1f} GB')
"
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────
main() {
  check_ollama

  if [[ "${1:-}" == "list" ]]; then
    print_summary
    exit 0
  fi

  # If a specific model is passed as an argument, pull only that one
  if [[ -n "${1:-}" ]]; then
    pull_model "$1"
  else
    log "Installing ${#MODELS[@]} models..."
    for model in "${MODELS[@]}"; do
      pull_model "$model"
    done
  fi

  print_summary
}

main "$@"
