# Launch Guide

Step-by-step to bring up the AI stack (n8n + Hermes gateway + local Ollama).

## Architecture recap

- **Sadida** — Proxmox host. Runs the k3s control-plane and **Ollama locally**
  (only node with a discrete GPU, RTX 3050). Models: `qwen3:1.7b` (intent
  classifier) and `qwen3.5:4b` (main agent).
- **Ocra** — always-on "brain". Runs the Docker Compose stack:
  `postgres` + `tailscale` sidecar + `n8n` + `hermes-gateway`.
- **Hermes** — custom HTTP gateway (`:8080`) exposing tools (filesystem, shell,
  Ollama, Claude) to n8n. Reaches Ollama on Sadida via Tailscale MagicDNS.

## Prerequisites

- Ollama installed and running on Sadida (host service, GPU).
- Ocra powered on with Docker + Docker Compose.
- A reusable Tailscale auth key (https://login.tailscale.com/admin/settings/keys).

## 1. Pull the models on Sadida (one time)

```bash
ssh seth@sadida
ollama pull qwen3:1.7b      # intent classifier
ollama pull qwen3.5:4b      # main agent
curl http://localhost:11434/api/tags   # verify both respond
```

## 2. Configure the environment on Ocra

```bash
cd ~/HomeLab_Architecture/n8n
cp .env.example .env   # if you do not have it yet
```

Fill in:

- `TS_AUTHKEY` — Tailscale auth key.
- `POSTGRES_PASSWORD` — database password (must match the existing
  `postgres_data` volume if the DB was already initialized).
- `N8N_ENCRYPTION_KEY` — `openssl rand -hex 32`. **Do NOT rotate** on an existing
  install; you would lose access to saved n8n credentials.
- `ANTHROPIC_API_KEY` — leave **empty** if you have no key. Hermes will
  automatically fall back to the local Qwen model for `claude_chat` calls.

Leave all capability toggles at `false` for now (see step 7).

## 3. Bring up the stack

```bash
sudo docker compose up -d --build
sudo docker compose ps     # postgres, tailscale, n8n, hermes-gateway
```

## 4. Verify Hermes

```bash
# Health: shows reachable Ollama, active capabilities, and the fallback mode.
sudo docker exec hermes_gateway wget -qO- localhost:8080/health

# Tool list (fs_delete only appears when HERMES_FS_ALLOW_DELETE=true).
sudo docker exec hermes_gateway wget -qO- localhost:8080/tools
```

Expected in `/health`: `claude_fallback: "ollama:qwen3.5:4b"` (while
`ANTHROPIC_API_KEY` is empty).

## 5. Test the Qwen fallback end-to-end

```bash
sudo docker exec hermes_gateway wget -qO- \
  --post-data='{"prompt":"Say hello in one word"}' \
  --header='Content-Type: application/json' \
  localhost:8080/tool/claude_chat

# The fallback is logged here:
sudo docker logs hermes_gateway | tail
```

## 6. n8n workflow

1. Open `https://ocra.stegosaurus-panga.ts.net`.
2. Import `n8n/cerebro_workflow_v2.json`.
3. Connect the Telegram bot credential (the token lives in n8n, not in `.env`).
4. Activate the workflow.

## 7. Enable capabilities when needed

Everything is locked down by default. Grant a capability by setting its env var
to `true` in `.env`, then reload with `sudo docker compose up -d`.

| Capability | Env var | Default |
| --- | --- | --- |
| SSH/scp/sftp/rsync to cluster nodes | `HERMES_ALLOW_SSH` | `false` |
| Any command via `bash -lc` (full shell) | `HERMES_ALLOW_UNRESTRICTED_SHELL` | `false` |
| Extra allowlisted binaries (e.g. `rm,mv,cp,tar`) | `HERMES_SHELL_EXTRA` | empty |
| Read/write/delete outside `/workspace` | `HERMES_FS_UNRESTRICTED` | `false` |
| `fs_write` to any path | `HERMES_FS_ALLOW_WRITE_ANYWHERE` | `false` |
| Enable the `fs_delete` tool | `HERMES_FS_ALLOW_DELETE` | `false` |
| Local model used when Claude is unavailable | `HERMES_CLAUDE_FALLBACK_MODEL` | `qwen3.5:4b` |

### Enabling SSH

1. Set `HERMES_ALLOW_SSH=true` in `.env`.
2. Uncomment the SSH key mounts in `n8n/docker-compose.yaml` (hermes-gateway
   `volumes`) and point them at a dedicated key.
3. Authorize that key's public part on the target nodes (`~/.ssh/authorized_keys`).
4. `sudo docker compose up -d`.

Because Hermes shares the Tailscale network, it can reach every node by its
MagicDNS name once SSH is enabled.

> **Security note:** `HERMES_ALLOW_UNRESTRICTED_SHELL=true` grants effectively
> full control of the Hermes container, and via Tailscale it can reach every
> node. Enable powerful toggles only while you need them.

## Common commands

```bash
sudo docker compose logs -f hermes-gateway   # follow Hermes logs
sudo docker compose logs -f n8n              # follow n8n logs
sudo docker compose restart hermes-gateway   # restart after a code change
sudo docker compose down                     # stop the stack (keeps volumes)
```
