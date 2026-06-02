#!/usr/bin/env bash
# scripts/ai/pull-models.sh
# Descarga los modelos AI en Ollama (corre en la VM nitro-ollama)
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

OLLAMA_HOST="${OLLAMA_HOST:-http://192.168.1.12:11434}"

log()  { echo -e "${CYAN}[Ollama]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ── Modelos a instalar ────────────────────────────────────────────
# Con 32GB RAM y GPU, estos modelos corren bien:
# - llama3:8b       ~5 GB  — rápido, bueno para tasks generales
# - mistral:7b      ~4 GB  — eficiente, gran calidad
# - hermes2:7b      ~4 GB  — ajustado para instrucciones
# - codellama:13b   ~8 GB  — para Sram (coding)
# Ajusta según VRAM disponible de tu GPU

MODELS=(
  "llama3:8b"
  "mistral:7b"
  "hermes2-pro-llama3:8b"
  "codellama:13b"
)

check_ollama() {
  log "Verificando Ollama en ${OLLAMA_HOST}..."
  if ! curl -sf "${OLLAMA_HOST}/api/tags" &>/dev/null; then
    err "No se puede conectar a Ollama en ${OLLAMA_HOST}"
  fi
  ok "Ollama responde"
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
    ok "Modelo '${model}' ya instalado — saltando"
    return 0
  fi

  log "Descargando ${BLUE}${model}${NC}..."
  # Usar streaming para mostrar progreso
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
  ok "Modelo '${model}' listo"
}

print_summary() {
  echo ""
  log "Modelos instalados en Ollama:"
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

  # Si se pasa un modelo específico como argumento, solo ese
  if [[ -n "${1:-}" ]]; then
    pull_model "$1"
  else
    log "Instalando ${#MODELS[@]} modelos..."
    for model in "${MODELS[@]}"; do
      pull_model "$model"
    done
  fi

  print_summary
}

main "$@"
