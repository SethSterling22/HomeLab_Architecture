#!/usr/bin/env bash
# scripts/deploy.sh
# Despliega Hermes + Ollama en el cluster k3s
# Ejecutar desde Sadida con KUBECONFIG configurado
set -euo pipefail

NAMESPACE="cerebro"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> [1/5] Verificando KUBECONFIG..."
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl cluster-info --request-timeout=5s

echo ""
echo "==> [2/5] Etiquetando nodos..."
# Asegura que los nodeSelectors funcionen correctamente
kubectl label node ocra  kubernetes.io/hostname=ocra  --overwrite 2>/dev/null || true
kubectl label node sram  kubernetes.io/hostname=sram  --overwrite 2>/dev/null || true
kubectl label node xelor kubernetes.io/hostname=xelor --overwrite 2>/dev/null || true
kubectl label node sacro kubernetes.io/hostname=sacro --overwrite 2>/dev/null || true

echo "Nodos actuales:"
kubectl get nodes -o wide

echo ""
echo "==> [3/5] Aplicando manifests k8s..."
kubectl apply -f "$ROOT_DIR/k8s/hermes-stack.yaml"

echo ""
echo "==> [4/5] Esperando que los pods estén listos..."
kubectl -n "$NAMESPACE" wait deployment/ollama    --for=condition=available --timeout=120s || true
kubectl -n "$NAMESPACE" wait deployment/hermes-mcp --for=condition=available --timeout=60s || true

echo ""
echo "==> [5/5] Descargando modelos de Ollama..."
OLLAMA_POD=$(kubectl -n "$NAMESPACE" get pod -l app=ollama -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -n "$OLLAMA_POD" ]]; then
  echo "Pod de Ollama: $OLLAMA_POD"
  echo "Descargando qwen3:1.7b (classifier)..."
  kubectl -n "$NAMESPACE" exec "$OLLAMA_POD" -- ollama pull qwen3:1.7b || true
  echo "Descargando qwen3.5:4b (agente principal)..."
  kubectl -n "$NAMESPACE" exec "$OLLAMA_POD" -- ollama pull qwen3.5:4b || true
else
  echo "WARN: Pod de Ollama no encontrado — descarga modelos manualmente"
  echo "  kubectl -n $NAMESPACE exec -it <ollama-pod> -- ollama pull qwen3.5:4b"
fi

echo ""
echo "✓ Deploy completado."
echo ""
echo "Estado del namespace $NAMESPACE:"
kubectl -n "$NAMESPACE" get all

echo ""
echo "Para probar Hermes desde dentro del cluster:"
echo "  kubectl -n $NAMESPACE run test --rm -it --image=curlimages/curl -- \\"
echo "    curl -s http://hermes-mcp-svc:8080/health"
echo ""
echo "Para probar el tool fs_list:"
echo "  kubectl -n $NAMESPACE run test --rm -it --image=curlimages/curl -- \\"
echo "    curl -s -X POST http://hermes-mcp-svc:8080/tool/fs_list -H 'Content-Type: application/json' -d '{}'"
