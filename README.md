# HomeLab Infrastructure for High Availability

Complete infrastructure for a 6-node home cluster based on **k3s**, **Proxmox VE**, **Tailscale** and **Wake-on-LAN**, with a local AI agent stack backed by a GPU.

The AI layer follows a simple split: **Ollama runs locally on Sadida** (the only GPU node), and **Ocra is the 24/7 "brain"** running a Docker Compose stack (n8n + Hermes gateway + PostgreSQL + a Tailscale sidecar). Messages arrive over Telegram, n8n classifies intent, and Hermes routes each request to either the local Ollama model or the Claude API.

---

## Table of Contents

- [Nodes and Roles](#nodes-and-roles)
- [Network Architecture](#network-architecture)
- [AI Stack](#ai-stack)
- [Diagrams](#diagrams)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Daily Usage](#daily-usage)
- [Service Stack](#service-stack)
- [Project Structure](#project-structure)
- [Security Notes](#security-notes)

---

## Nodes and Roles

| Node | Base OS | Role | Availability |
|------|---------|------|--------------|
| **Sadida** | Proxmox VE 8 (Debian 13 Trixie kernel) | Hypervisor · k3s control-plane · **Ollama (local host service, GPU RTX 3050)** | 24/7 |
| **Aery** | Synology DSM | NAS · NFS persistent volumes (`/volume1/homes`) · Backup | 24/7 |
| **Sram** | Debian 13 Trixie (bare metal) | k3s worker · development environments (no GPU) | 24/7 |
| **Ocra** | Debian 13 Trixie (bare metal) | **Brain 24/7 — Docker Compose: n8n + Hermes gateway + PostgreSQL + Tailscale**; also a k3s worker | 24/7 |
| **Xelor** | Debian 13 Trixie (bare metal) | k3s worker on-demand · staging · CI/CD | On-demand |
| **Sacro** | Debian 13 Trixie (bare metal) | k3s worker on-demand · observability (Grafana / Loki) | On-demand |

### Node IPs

| Node | LAN IP | Role |
|------|--------|------|
| Sadida (Proxmox) | `192.168.68.10` | k3s control-plane · Ollama |
| Aery (Synology) | `192.168.68.190` | NFS server |
| Ocra | `192.168.68.100` | AI brain (Docker Compose) · k3s worker |
| Sram | `192.168.68.108` | k3s worker |
| Xelor | `192.168.68.114` | k3s worker (on-demand) |
| Sacro | `192.168.68.115` | k3s worker (on-demand) |

### k3s Cluster

The k3s control-plane runs directly on Sadida (Proxmox host), not inside a VM. Workers are bare-metal Debian 13 nodes joined via Tailscale IP for network resilience.

```
k3s v1.35.5+k3s1
Subnet: 192.168.68.0/24
Tailnet: stegosaurus-panga.ts.net (Tailscale MagicDNS)
```

---

## Network Architecture

```
Internet
   │
   └── Home Router (192.168.68.1)
          │
          └── Gigabit Ethernet Switch
                 ├── Sadida     192.168.68.10   (Proxmox + k3s master + Ollama)
                 ├── Aery       192.168.68.190  (Synology NAS)
                 ├── Ocra       192.168.68.100  (AI brain — Docker Compose)
                 ├── Sram       192.168.68.108  (k3s worker)
                 ├── Xelor      192.168.68.114  (k3s worker, on-demand)
                 └── Sacro      192.168.68.115  (k3s worker, on-demand)
```

**Tailscale mesh VPN** runs on all nodes, providing stable addressing independent of local network changes. Workers join the k3s cluster using Tailscale IPs so the cluster remains functional across network reconfigurations. Nodes reach each other by MagicDNS names such as `sadida.stegosaurus-panga.ts.net`.

**NFS mount on Sadida:**
```
192.168.68.190:/volume1/homes → /mnt/data
```
Mounted read-write via `/etc/fstab` with the `_netdev` flag; auto-mounts on reboot once the network is available.

---

## AI Stack

The AI layer is split into two concerns. **This repository owns the infrastructure side** — the GPU host that serves the models and the always-on node that hosts the automation stack. **The automation stack itself (n8n, Hermes, the agents) has moved to `Productivity_Tools/`** and is intended to become a separate repository; see `Productivity_Tools/README.md` and `Productivity_Tools/HANDOFF.md`.

**Ollama on Sadida (local, not a pod).** Sadida is the only node with a discrete GPU (RTX 3050), so Ollama runs as a local host service on port `11434`. Running it directly on the host avoids an unnecessary orchestration layer and gives the models direct GPU access. Two models are installed (see `scripts/ai/pull-models.sh`): `qwen3:1.7b` as the intent classifier and `qwen3.5:4b` as the main conversational agent. **Ollama and its provisioning stay in this repo** — they are infrastructure the automation layer consumes over Tailscale.

**Ocra as the 24/7 host.** Ocra runs the automation stack via Docker Compose (`Productivity_Tools/n8n/docker-compose.yaml`): n8n, the Hermes gateway, PostgreSQL, and a Tailscale sidecar. From an infrastructure standpoint, this repo only guarantees that Ocra is powered, on the Tailscale network, and running Docker; the stack's internals are documented in `Productivity_Tools/`.

**In-cluster access to Ollama.** For workloads that run inside k3s, `k3s/manifests/ai/ollama.yaml` exposes Ollama through an `ExternalName` Service (`ollama.ai.svc.cluster.local:11434` → Sadida over Tailscale). `k3s/manifests/ai/apps.yaml` carries an optional chat web UI (OpenClaw) that talks to it.

---

## Diagrams

### Node Overview

```mermaid
graph TB
    subgraph always_on["🟢 Always On"]
        SADIDA["🖥️ Sadida\nProxmox VE · k3s master\nOllama (local, GPU)\n192.168.68.10"]
        AERY["💾 Aery\nSynology DSM · NAS\n192.168.68.190"]
    end

    subgraph workers_24["🔵 Nodes 24/7"]
        OCRA["🧠 Ocra\nDocker Compose brain\nn8n + Hermes + postgres\n192.168.68.100"]
        SRAM["💻 Sram\nDebian 13 · k3s worker\n192.168.68.108"]
    end

    subgraph workers_od["🟡 Workers On-Demand (WOL)"]
        XELOR["💤 Xelor\nDebian 13 · staging\n192.168.68.114"]
        SACRO["💤 Sacro\nDebian 13 · observability\n192.168.68.115"]
    end

    subgraph network["🌐 Network"]
        SWITCH["Gigabit Switch\nEthernet"]
        TAILSCALE["Tailscale Mesh VPN\nAll nodes connected"]
    end

    subgraph storage["💽 Storage"]
        NFS["Aery NFS\n/volume1/homes\n→ /mnt/data on Sadida"]
    end

    OCRA -->|Ollama API :11434| SADIDA
    SADIDA -->|k3s API| SRAM
    SADIDA -.->|on-demand| XELOR
    SADIDA -.->|on-demand| SACRO
    AERY -->|NFS mount| SADIDA

    SWITCH --- SADIDA
    SWITCH --- AERY
    SWITCH --- SRAM
    SWITCH --- OCRA
    SWITCH --- XELOR
    SWITCH --- SACRO

    TAILSCALE --- SADIDA
    TAILSCALE --- SRAM
    TAILSCALE --- OCRA
    TAILSCALE --- XELOR
    TAILSCALE --- SACRO
    TAILSCALE --- AERY
```

### AI Service Flow

```mermaid
sequenceDiagram
    actor User
    participant TG as Telegram
    participant n8n as n8n (Ocra)
    participant Hermes as Hermes gateway (Ocra :8080)
    participant Ollama as Ollama (Sadida GPU :11434)
    participant Claude as Claude API

    User->>TG: Sends a message
    TG->>n8n: Telegram trigger
    n8n->>Hermes: POST /tool/ollama_chat (classify intent, qwen3:1.7b)
    Hermes->>Ollama: /api/chat
    Ollama-->>Hermes: intent
    Hermes-->>n8n: intent
    alt technical / high quality
        n8n->>Hermes: POST /tool/claude_chat
        Hermes->>Claude: messages API
        Claude-->>Hermes: response
    else chat / simple
        n8n->>Hermes: POST /tool/ollama_chat (qwen3.5:4b)
        Hermes->>Ollama: /api/chat
        Ollama-->>Hermes: response
    end
    Hermes-->>n8n: response
    n8n->>TG: Send reply
    TG-->>User: Answer
```

### k3s Stack (optional / future route)

```mermaid
graph LR
    subgraph ingress["Ingress Layer"]
        TRAEFIK["Traefik\nIngress Controller"]
    end

    subgraph ai["AI Namespace"]
        OC["OpenClaw\n(optional web UI)"]
        HM["Hermes\n(Productivity_Tools/hermes-agent/k8s)"]
        OL["ollama Service\n(ExternalName → Sadida)"]
    end

    subgraph storage["Storage"]
        PVC["PersistentVolumeClaims"]
        NFS["NFS → Aery\n/volume1/homes"]
    end

    subgraph monitoring["Monitoring Namespace"]
        PROM["Prometheus"]
        GRAF["Grafana"]
        LOKI["Loki"]
    end

    TRAEFIK --> OC
    TRAEFIK --> GRAF
    OC --> OL
    HM --> OL
    OL -.->|Tailscale| SADIDA["Ollama on Sadida\n(local host service)"]
    OC --> PVC
    PVC --> NFS
    PROM --> GRAF
    LOKI --> GRAF
```

### Wake-on-LAN Flow

```mermaid
flowchart TD
    DEV["Your device\n(Tailscale client)"]
    TS["Tailscale Network"]
    SADIDA["Sadida\nWOL relay"]
    WOL["wakeonlan script"]
    SWITCH["Ethernet Switch\n(broadcast domain)"]
    XELOR["Xelor wakes up 🟢"]
    SACRO["Sacro wakes up 🟢"]

    DEV -->|SSH / script| TS
    TS --> SADIDA
    SADIDA --> WOL
    WOL -->|magic packet UDP 9| SWITCH
    SWITCH --> XELOR
    SWITCH --> SACRO

    XELOR -->|joins cluster| K3S["k3s master\n(Sadida)"]
    SACRO -->|joins cluster| K3S
```

---

## Prerequisites

- **Sadida:** Proxmox VE 8.x installed, BIOS with VT-d enabled for GPU passthrough, `_netdev` NFS mount configured, Ollama installed as a local service with the two models pulled
- **Aery:** Synology DSM with NFS service enabled, `/volume1/homes` exported to `192.168.68.0/24` and `100.0.0.0/8`
- **Ocra:** Debian 13 Trixie, Docker + Docker Compose installed (this is where the AI brain runs)
- **Sram / Xelor / Sacro:** Debian 13 Trixie installed, user with sudo, SSH active
- **Network:** All nodes on the same broadcast domain (same switch)
- **WOL:** Enabled in BIOS on Xelor and Sacro; NICs compatible with magic packets
- **Tailscale:** Active account; auth key generated at `https://login.tailscale.com/admin/settings/keys`
- **Claude API:** Anthropic API key from `https://console.anthropic.com/settings/keys`
- **Ansible:** `ansible >= 2.14` on your local machine
- **kubectl + helm:** Installed on your local machine (for the optional k8s route)

---

## Quick Start

### 1. Provision the cluster (Ansible + k3s)

```bash
# Clone this repository
git clone <your-repo> homelab && cd homelab

# Copy and edit the inventory with your real IPs and MACs
cp ansible/inventory/hosts.yml.example ansible/inventory/hosts.yml
$EDITOR ansible/inventory/hosts.yml

# Configure variables (Tailscale auth key, SSH keys, etc.)
cp ansible/inventory/group_vars/all.yml.example ansible/inventory/group_vars/all.yml
$EDITOR ansible/inventory/group_vars/all.yml

# Bootstrap all nodes, configure Proxmox, install k3s
ansible-playbook ansible/playbooks/bootstrap.yml
ansible-playbook ansible/playbooks/proxmox.yml
ansible-playbook ansible/playbooks/k3s.yml

# (Optional) apply cluster manifests and verify
kubectl apply -k k3s/manifests/
kubectl get nodes -o wide
```

### 2. Pull the AI models on Sadida

```bash
# Ollama runs locally on Sadida; pull the two models the stack expects
./scripts/ai/pull-models.sh          # qwen3:1.7b + qwen3.5:4b
./scripts/ai/pull-models.sh list     # show what is installed
```

### 3. Launch the AI brain on Ocra (Docker Compose)

```bash
cd Productivity_Tools/n8n
cp .env.example .env      # fill in TS_AUTHKEY, ANTHROPIC_API_KEY, POSTGRES_PASSWORD, N8N_ENCRYPTION_KEY
sudo docker compose up -d --build   # --build builds the Hermes image from ../hermes-agent/mcp-server

# Verify
sudo docker compose ps
sudo docker exec n8n_core wget -qO- http://127.0.0.1:8080/health   # Hermes responds
curl -s http://sadida.stegosaurus-panga.ts.net:11434/api/tags      # Ollama reachable
```

Then open the n8n UI at `https://ocra.stegosaurus-panga.ts.net/`, configure the Telegram credential (the bot token lives in n8n, not in `.env`), import `Productivity_Tools/n8n/cerebro_workflow_v2.json`, and activate the workflow. The automation stack's own docs live in `Productivity_Tools/` (README, HANDOFF, LAUNCH).

---

## Daily Usage

### Wake / power down on-demand nodes

```bash
./scripts/wol/wake.sh xelor        # Wake Xelor
./scripts/wol/wake.sh all          # Wake all workers
./scripts/wol/status.sh            # Status of all nodes + Ollama
./scripts/wol/shutdown.sh xelor    # Drain from k3s and power off
```

### Manage the AI brain on Ocra

```bash
cd Productivity_Tools/n8n
sudo docker compose ps                 # container status
sudo docker compose logs -f n8n        # follow n8n logs
sudo docker compose logs -f hermes-gateway
sudo docker compose restart hermes-gateway
sudo docker compose up -d --build      # rebuild after editing Hermes code
```

### Manage the k3s cluster

```bash
kubectl get nodes -o wide
kubectl get pods -n ai                 # optional AI namespace (OpenClaw, etc.)
./scripts/k3s/join-worker.sh xelor     # join a worker manually after WOL
```

### Mount Aery NFS manually (if needed)

```bash
mount /mnt/data
# or force remount of all fstab entries:
mount -a
```

---

## Service Stack

### Ocra — Docker Compose (primary AI stack)

| Service | Container | Port | Description |
|---------|-----------|------|-------------|
| n8n | `n8n_core` | 5678 (via Tailscale sidecar) | Workflow orchestrator, Telegram trigger |
| Hermes gateway | `hermes_gateway` | 8080 (internal) | Routes to Ollama / Claude, sandboxed tools |
| PostgreSQL | `n8n_postgres` | 5432 (internal) | n8n database |
| Tailscale | `n8n_tailscale` | — | Sidecar; publishes n8n UI on the tailnet |

### Sadida — local host service

| Service | Port | Description |
|---------|------|-------------|
| Ollama | 11434 | Local LLM engine (GPU); `qwen3:1.7b`, `qwen3.5:4b` |

### k3s cluster (optional / future)

| Service | Namespace | External path | Description |
|---------|-----------|---------------|-------------|
| Traefik | kube-system | 80 / 443 | Ingress controller |
| OpenClaw | ai | /openclaw | Optional chat web UI |
| ollama (ExternalName) | ai | :11434 (internal) | Points to Ollama on Sadida |
| Hermes | ai | internal | Optional k8s deployment (`Productivity_Tools/hermes-agent/k8s`) |
| Prometheus | monitoring | /prometheus | Cluster metrics |
| Grafana | monitoring | /grafana | Dashboards |
| Loki | monitoring | internal | Log aggregation |
| Portainer | portainer | :30777 | Cluster management UI (see `PORTAINER.md`) |

---

## Project Structure

```
homelab/
├── README.md                        ← This file
├── PORTAINER.md                     ← Portainer install guide (cluster UI)
├── ansible/
│   ├── inventory/
│   │   ├── hosts.yml.example        ← IPs, MACs, node groups
│   │   └── group_vars/
│   │       └── all.yml.example      ← Global variables (tokens, keys)
│   ├── playbooks/
│   │   ├── bootstrap.yml            ← Base setup for all nodes
│   │   ├── proxmox.yml              ← Proxmox configuration on Sadida
│   │   └── k3s.yml                  ← Cluster installation
│   └── roles/
│       └── common/                  ← Base packages, SSH hardening
├── Productivity_Tools/              ← AUTOMATION stack (own repo-to-be; see its README/HANDOFF)
│   ├── README.md                    ← Automation overview + adapting guide
│   ├── HANDOFF.md                   ← Context brief for the automation agent
│   ├── LAUNCH.md                    ← Step-by-step bring-up
│   ├── n8n/                         ← Docker Compose stack (n8n + Hermes + postgres + tailscale)
│   │   ├── docker-compose.yaml
│   │   ├── .env.example
│   │   └── cerebro_workflow_v2.json ← Telegram → Hermes routing workflow
│   └── hermes-agent/                ← Hermes gateway (agent brain)
│       ├── mcp-server/              ← gateway.js (:8080), server.js (MCP), Dockerfile
│       ├── k8s/hermes-stack.yaml    ← Optional k8s deployment (Hermes only)
│       └── scripts/deploy.sh
├── k3s/
│   └── manifests/
│       ├── namespaces/              ← Cluster namespaces (ai, monitoring, storage)
│       ├── storage/                 ← NFS StorageClass + PVCs
│       ├── ai/                      ← ollama ExternalName + optional OpenClaw
│       ├── monitoring/              ← Prometheus, Grafana, Loki
│       └── ingress/                 ← Traefik IngressRoutes
├── scripts/
│   ├── bootstrap/
│   │   └── node-init.sh             ← First-boot script for a fresh Debian node
│   ├── wol/
│   │   ├── wake.sh                  ← Send magic packet to a node
│   │   ├── shutdown.sh              ← Drain from k3s and power off
│   │   └── status.sh                ← Node status + Ollama models
│   ├── k3s/
│   │   └── join-worker.sh           ← Join a worker to the cluster
│   └── ai/
│       └── pull-models.sh           ← Pull models into Ollama on Sadida
└── docs/
    └── proxmox-gpu-passthrough.md   ← GPU passthrough step-by-step guide
```

---

## Security Notes

- Secrets for the Ocra stack live in `Productivity_Tools/n8n/.env`, which is **never committed** (see `.gitignore`). The Telegram bot token is stored inside n8n, not in `.env`.
- The `N8N_ENCRYPTION_KEY` must **not** be rotated on an existing install — doing so loses access to credentials already saved in n8n.
- Hermes runs sandboxed: non-root (UID 1001), all kernel capabilities dropped, a shell allowlist, and writes only to `/workspace/output`.
- Kubernetes secrets (optional route) are managed with **Sealed Secrets**.
- `ansible/inventory/group_vars/all.yml` is **never committed**.
- Recommended Tailscale ACLs: only Sadida has access to the full subnet route.
- SSH on all nodes: public key authentication only, root login disabled.
- NFS export is restricted to `192.168.68.0/24` and `100.0.0.0/8` (Tailscale range).
