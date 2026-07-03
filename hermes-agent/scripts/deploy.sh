#!/usr/bin/env bash
# scripts/deploy.sh
# Deploys ONLY Hermes to the k3s cluster (optional k8s route).
#
# NOTE: The primary functional route is Docker Compose on Ocra (see n8n/docker-compose.yaml).
# Ollama is NOT deployed here: it runs locally on Sadida (host, the only node with a GPU).
# Models are installed directly on Sadida:
#   ollama pull qwen3:1.7b
#   ollama pull qwen3.5:4b
#
# Run from Sadida with KUBECONFIG configured.
set -euo pipefail

NAMESPACE="cerebro"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> [1/4] Checking KUBECONFIG..."
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl cluster-info --request-timeout=5s

echo ""
echo "==> [2/4] Labeling nodes (for Hermes nodeSelector → Ocra)..."
kubectl label node ocra kubernetes.io/hostname=ocra --overwrite 2>/dev/null || true

echo "Current nodes:"
kubectl get nodes -o wide

echo ""
echo "==> [3/4] Applying k8s manifests (namespace, secret, config, PVC, Hermes)..."
kubectl apply -f "$ROOT_DIR/k8s/hermes-stack.yaml"

echo ""
echo "==> [4/4] Waiting for Hermes to become ready..."
kubectl -n "$NAMESPACE" wait deployment/hermes-mcp --for=condition=available --timeout=60s || true

echo ""
echo "✓ Deploy complete."
echo ""
echo "Remember: Ollama must be running on Sadida and reachable over Tailscale."
echo "  Verify from Ocra:  curl -s http://sadida.stegosaurus-panga.ts.net:11434/api/tags"
echo ""
echo "Status of namespace $NAMESPACE:"
kubectl -n "$NAMESPACE" get all

echo ""
echo "To test Hermes from inside the cluster:"
echo "  kubectl -n $NAMESPACE run test --rm -it --image=curlimages/curl -- \\"
echo "    curl -s http://hermes-mcp-svc:8080/health"
echo ""
echo "To test the fs_list tool:"
echo "  kubectl -n $NAMESPACE run test --rm -it --image=curlimages/curl -- \\"
echo "    curl -s -X POST http://hermes-mcp-svc:8080/tool/fs_list -H 'Content-Type: application/json' -d '{}'"
