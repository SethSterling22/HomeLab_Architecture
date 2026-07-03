# Hermes — Agent Brain for the Home Lab

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ 192.168.68.0/24 + Tailscale overlay                             │
│                                                                 │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │    SADIDA     │  │       OCRA       │  │      SRAM        │  │
│  │ .68.10       │  │ .68.100          │  │ .68.108          │  │
│  │              │  │                  │  │                  │  │
│  │ Proxmox VE   │  │ hermes-mcp (pod) │  │ ollama (pod)     │  │
│  │ k3s master   │  │ n8n (pod)        │  │ qwen3.5:4b       │  │
│  │ NFS → Aery   │  │ sandbox /ws      │  │ qwen3:1.7b       │  │
│  │              │  │                  │  │                  │  │
│  │ NO LLM aquí  │  │ cerebro 24/7     │  │ inferencia 24/7  │  │
│  └──────────────┘  └────────┬─────────┘  └──────────────────┘  │
│                             │ API calls                         │
└─────────────────────────────┼───────────────────────────────────┘
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
         Claude API      Telegram Bot      Aery NAS
         (anthropic)     (tu interfaz)    (storage)
```

## Node Responsibilities

| Node   | IP             | Role           | Services              |
|--------|----------------|----------------|-----------------------|
| Sadida | 192.168.68.10  | Master / Infra | Proxmox, k3s control-plane, NFS |
| Ocra   | 192.168.68.100 | Brain 24/7     | hermes-mcp, n8n, sandbox |
| Sram   | 192.168.68.108 | Inference 24/7 | Ollama (qwen3.5:4b, qwen3:1.7b) |
| Xelor  | 192.168.68.114 | On-demand      | Staging / CI          |
| Sacro  | 192.168.68.115 | On-demand      | Observability         |
| Aery   | 192.168.68.190 | NAS            | NFS storage backend   |

## Why This Split

**Sadida stays clean**: Proxmox + k3s control-plane are latency-sensitive. An LLM doing inference on the same machine that schedules pods causes resource contention.

**Ocra = brain**: Hermes MCP server + n8n run here 24/7. Lightweight processes. All external API calls (Claude, Telegram) originate here.

**Sram = inference**: Ollama runs in isolation. If you need to restart it, reload models, or change hardware — it doesn't affect the brain.

## Sandbox Design

Hermes runs inside a k8s Pod with:

- `runAsNonRoot: true` — never root
- `capabilities: drop ALL` — no kernel capabilities
- `hostNetwork: false` — isolated network
- `/workspace` as a PVC bind mount — the only filesystem it can touch
- Shell allowlist — only specific commands allowed: `ls`, `find`, `cat`, `grep`, `git`, `curl`, etc.
- Write access only to `/workspace/output/`

This is why the previous `ls` attempt failed: the container was seeing its own empty root filesystem. Now `/workspace` is explicitly mounted from NFS, so `ls /workspace` returns real files.

## Setup

### 1. Label nodes

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl label node ocra  kubernetes.io/hostname=ocra  --overwrite
kubectl label node sram  kubernetes.io/hostname=sram  --overwrite
```

### 2. Set secrets

```bash
kubectl create namespace cerebro
kubectl create secret generic hermes-secrets -n cerebro \
  --from-literal=ANTHROPIC_API_KEY="sk-ant-YOUR_KEY" \
  --from-literal=TELEGRAM_BOT_TOKEN="YOUR_BOT_TOKEN"
```

### 3. Build and push the image

```bash
cd mcp-server
# Option A: build directly on Ocra
ssh user@ocra "docker build -t hermes-mcp:local /path/to/mcp-server"

# Option B: use a local registry (recommended for the cluster)
docker build -t your-registry/hermes-mcp:latest .
docker push your-registry/hermes-mcp:latest
# Update image in hermes-stack.yaml accordingly
```

### 4. Deploy

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

### 5. Verify

```bash
# Health check
kubectl -n cerebro run test --rm -it --image=curlimages/curl --restart=Never -- \
  curl -s http://hermes-mcp-svc:8080/health

# Test fs_list (this was the failing ls)
kubectl -n cerebro run test --rm -it --image=curlimages/curl --restart=Never -- \
  curl -s -X POST http://hermes-mcp-svc:8080/tool/fs_list \
  -H 'Content-Type: application/json' -d '{}'

# Test shell_exec with ls
kubectl -n cerebro run test --rm -it --image=curlimages/curl --restart=Never -- \
  curl -s -X POST http://hermes-mcp-svc:8080/tool/shell_exec \
  -H 'Content-Type: application/json' -d '{"command": "ls -la /workspace"}'
```

## n8n Integration

In n8n, replace any Ollama direct call with an HTTP Request to Hermes:

```
POST http://hermes-mcp-svc.cerebro.svc.cluster.local:8080/tool/ollama_chat
Content-Type: application/json

{
  "prompt": "{{ $json.raw_text }}",
  "model": "qwen3.5:4b",
  "system": "Eres el clasificador de intenciones..."
}
```

For Claude:
```
POST http://hermes-mcp-svc.cerebro.svc.cluster.local:8080/tool/claude_chat
Content-Type: application/json

{
  "prompt": "{{ $json.raw_text }}",
  "system": "Eres el asistente de Sebastian..."
}
```

For file operations:
```
POST http://hermes-mcp-svc.cerebro.svc.cluster.local:8080/tool/shell_exec
Content-Type: application/json

{
  "command": "ls /workspace"
}
```

## Adding New Tools

Edit `mcp-server/gateway.js`, add a new key to the `TOOLS` object:

```js
my_new_tool: async ({ param1, param2 }) => {
  // implement
  return "result string";
},
```

The allowlist for shell commands is in `SHELL_ALLOWLIST`. Add commands there if needed.

## Troubleshooting

**Pod stuck in Pending**: Check nodeSelector matches the actual node hostname.
```bash
kubectl get nodes --show-labels | grep hostname
```

**fs_list returns empty**: The PVC isn't mounted or the NFS path is wrong. Check:
```bash
kubectl -n cerebro describe pvc hermes-workspace-pvc
```

**Ollama not reachable**: Verify the service name from Ocra:
```bash
kubectl -n cerebro run test --rm -it --image=curlimages/curl --restart=Never -- \
  curl -s http://ollama-svc:11434/api/tags
```

**Permission denied in workspace**: The files are owned by a different UID. Fix:
```bash
# On the NFS host (Aery), set open permissions on the share path
chown -R 1001:1001 /volume1/homes/cerebro-workspace
```
