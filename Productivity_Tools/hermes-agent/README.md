# Hermes — Agent Brain for the Home Lab

Hermes is the HTTP gateway that acts as the brain of the home lab. n8n receives messages
(Telegram) and routes them to Hermes; Hermes decides between **Ollama** (local LLM on Sadida)
or the **Claude API** depending on the intent of the request.

## Architecture (actual state)

```
┌──────────────────────────────────────────────────────────────────────┐
│ 192.168.68.0/24 + Tailscale overlay (stegosaurus-panga.ts.net)         │
│                                                                        │
│  ┌────────────────────────┐        ┌────────────────────────────────┐ │
│  │         SADIDA          │        │             OCRA               │ │
│  │        .68.10           │        │            .68.100             │ │
│  │                         │        │                                │ │
│  │  Proxmox VE + k3s CP    │        │  Docker Compose:               │ │
│  │  Ollama LOCAL (host)    │◄───────┤   • n8n (Telegram workflow)    │ │
│  │   RTX 3050 · :11434     │ Ollama │   • hermes-gateway (:8080)     │ │
│  │   qwen3:1.7b            │  API   │   • postgres                   │ │
│  │   qwen3.5:4b            │        │   • tailscale (sidecar)        │ │
│  └────────────────────────┘        └───────────────┬────────────────┘ │
│                                                     │ API calls        │
└─────────────────────────────────────────────────────┼──────────────────┘
                                          ┌────────────┼─────────────┐
                                          ▼            ▼             ▼
                                     Claude API   Telegram Bot   Aery NAS
                                     (anthropic)  (interface)    (storage)
```

## Responsibilities per node

| Node   | IP             | Role           | Services                                    |
|--------|----------------|----------------|---------------------------------------------|
| Sadida | 192.168.68.10  | Master / Infra | Proxmox, k3s control-plane, NFS, **Ollama (local, GPU)** |
| Ocra   | 192.168.68.100 | Brain 24/7     | n8n + hermes-gateway + postgres (Docker Compose) |
| Sram   | 192.168.68.108 | Worker / dev   | k3s worker (NO GPU — does not run Ollama)   |
| Xelor  | 192.168.68.114 | On-demand      | Staging / CI                                |
| Sacro  | 192.168.68.115 | On-demand      | Observability                               |
| Aery   | 192.168.68.190 | NAS            | NFS storage backend                         |

## Why this split

**Ollama on Sadida (local, not a pod):** Sadida is the only node with a discrete GPU (RTX 3050).
It runs as a local host service, not as a k8s pod: this avoids an unnecessary orchestration
layer for this functionality. Hermes reaches it over Tailscale/local IP on `:11434`.

**Ocra = brain 24/7:** n8n + Hermes run here via Docker Compose. Lightweight processes.
All external calls (Claude, Telegram) originate here.

**Sram does NOT run Ollama:** it only has integrated Intel graphics. It is a k3s worker / dev node.

## Components in `mcp-server/`

| File         | Role                                                                   |
|--------------|------------------------------------------------------------------------|
| `gateway.js` | **HTTP server on :8080** — tools via `POST /tool/:name`. This is what n8n uses. |
| `server.js`  | Native MCP server over stdio (optional, for MCP clients).              |
| `Dockerfile` | Node 20 Alpine image, user `hermes:1001`. Runs `gateway.js` by default. |
| `package.json` | Dependencies.                                                        |

**Tools:** `fs_list`, `fs_read`, `fs_write` (only `/workspace/output`), `shell_exec` (allowlist),
`ollama_chat`, `claude_chat`. Endpoints: `GET /health`, `GET /tools`, `POST /tool/:name`.

## Recommended deployment — Docker Compose on Ocra

The functional stack lives in `../n8n/docker-compose.yaml` (n8n + hermes-gateway + postgres + tailscale).

```bash
cd ../n8n
cp .env.example .env      # fill in TS_AUTHKEY, ANTHROPIC_API_KEY, POSTGRES_PASSWORD, N8N_ENCRYPTION_KEY
sudo docker compose up -d --build   # --build builds the hermes image from ../hermes-agent/mcp-server
```

Verification:

```bash
# n8n shares the netns with the tailscale sidecar, so localhost:8080 reaches Hermes
sudo docker exec n8n_core wget -qO- http://localhost:8080/health

# Ollama on Sadida reachable from Ocra
curl -s http://sadida.stegosaurus-panga.ts.net:11434/api/tags
```

## Alternative deployment — k8s (optional, future)

`k8s/hermes-stack.yaml` deploys **only Hermes** (namespace, secret, config, PVC, deployment, service).
Ollama is NOT included: it keeps running locally on Sadida. The ConfigMap's `OLLAMA_URL` points to Sadida.

```bash
kubectl create namespace cerebro
kubectl create secret generic hermes-secrets -n cerebro \
  --from-literal=ANTHROPIC_API_KEY="sk-ant-YOUR_KEY"
./scripts/deploy.sh
```

## Security sandbox

Hermes runs with:

- `runAsNonRoot: true` (UID 1001) — never root
- `capabilities: drop ALL` — no kernel capabilities
- `hostNetwork: false` — isolated network
- `/workspace` as the only accessible filesystem (PVC/volume)
- Shell allowlist — only specific commands: `ls`, `find`, `cat`, `grep`, `git`, `curl`, etc.
- Writes only to `/workspace/output/`

This is why the earlier `ls` was failing: the container saw its own empty FS. With `/workspace`
explicitly mounted, `ls /workspace` returns real files.

## Integration with n8n

In n8n, each LLM call is an HTTP Request to Hermes. Since n8n and hermes share
the netns of the Tailscale sidecar, the URL is `http://localhost:8080`:

```
POST http://localhost:8080/tool/ollama_chat
{ "prompt": "{{ $json.raw_text }}", "model": "qwen3.5:4b", "system": "..." }

POST http://localhost:8080/tool/claude_chat
{ "prompt": "{{ $json.raw_text }}", "system": "..." }
```

## Adding new tools

Edit `mcp-server/gateway.js` and add a key to the `TOOLS` object:

```js
my_new_tool: async ({ param1, param2 }) => {
  // implement
  return "result string";
},
```

The shell allowlist is in `SHELL_ALLOWLIST`. Add commands there if needed.
If you also use the stdio MCP, replicate the handler in `server.js`.

## Troubleshooting

**Hermes won't start / :8080 not responding**: confirm the image runs `gateway.js`
(not `server.js`). The Dockerfile already does this by default.

**Ollama not responding**: verify it is running on Sadida and reachable over Tailscale:
```bash
curl -s http://sadida.stegosaurus-panga.ts.net:11434/api/tags
```

**fs_list empty**: the `/workspace` volume is not mounted. Check the volume in compose
or the PVC in k8s.

**Permission denied on workspace**: the files belong to another UID. On the NFS host (Aery):
```bash
chown -R 1001:1001 /volume1/homes/cerebro-workspace
```
