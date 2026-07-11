# HomeLab Architecture — Agent Scope

This repository is owned by the **HomeLab Architecture agent**. Its job is the
**infrastructure**: the physical/virtual nodes, the network, k3s, storage,
Proxmox, Tailscale, Wake-on-LAN, and the provisioning that keeps them running.

## Conventions

- **All code, comments, and documentation in English.**
- **Conversation with the user in Spanish.**

## In scope (this repo)

- Nodes and roles (Sadida, Aery, Ocra, Sram, Xelor, Sacro) and their IPs/MACs.
- Network: LAN, Tailscale mesh, MagicDNS, NFS mounts.
- k3s cluster: control-plane on Sadida, workers, `k3s/manifests/` (namespaces,
  storage, ingress, monitoring, and the `ai/` manifests — `ollama.yaml`
  ExternalName and `apps.yaml` OpenClaw UI).
- Proxmox host config and GPU passthrough (`docs/proxmox-gpu-passthrough.md`).
- **Ollama as a local host service on Sadida** (GPU, port 11434) and its
  provisioning (`scripts/ai/pull-models.sh`). Ollama is infrastructure the
  automation layer consumes over Tailscale — it stays here.
- Ansible provisioning (`ansible/`), WOL and k3s helper scripts (`scripts/`).
- Guaranteeing Ocra is powered, on Tailscale, and running Docker so the
  automation stack has a home. This repo does **not** own that stack's internals.

## Out of scope (belongs to the Productivity automation agent)

The automation stack lives in `Productivity_Tools/` and is intended to become a
separate repository. Do **not** modify its internals from here:

- **n8n** workflows (`Productivity_Tools/n8n/`, incl. `cerebro_workflow_v2.json`).
- **Hermes** gateway and MCP server (`Productivity_Tools/hermes-agent/`).
- The agents (Chat, Claude, Note, Task) and planned agents (Content, Progress,
  Calendar/Google Calendar).
- Skills and any automation-layer integrations (Obsidian/git, Linear, Google
  Calendar).

If an automation change needs an infrastructure change (a new port, a firewall
rule, a node, a storage class), make the infrastructure change here and **note**
what the automation agent must do on its side — don't edit `Productivity_Tools/`.

See `Productivity_Tools/README.md` and `Productivity_Tools/HANDOFF.md` for the
automation stack's own documentation.

## Infrastructure gotchas to preserve

- **Do NOT rotate `N8N_ENCRYPTION_KEY`** on an existing install — it invalidates
  saved n8n credentials.
- The real secrets live in `Productivity_Tools/n8n/.env` (gitignored); the
  Telegram bot token lives inside n8n, not in `.env`.
- User/linter edits to the Ocra IP/MAC and the Aery IP are intentional — do not
  revert them.
- Hermes and n8n share the Tailscale network namespace, so in-container calls
  use `127.0.0.1:8080` (busybox `wget` resolves `localhost` to IPv6 `::1`).
