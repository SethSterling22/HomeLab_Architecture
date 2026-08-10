# Monitoring & Node Control

Prometheus + Grafana + a small Control API, running on **Ocra**. Gives you one
page to see the fleet's health and energy cost, and to power nodes on and off.

Implements **Phases 0 and 1** of `docs/monitoring-stack-plan.md`.

## What you get

| | |
| --- | --- |
| **Status** | Online/offline badge per node (Xelor and Sacro read offline while asleep — that is the point) |
| **Resources** | CPU, memory, temperature, availability over time |
| **Energy** | Estimated watts per node, kWh and **USD cost** over any time range, projected monthly cost |
| **Control** | Wake / shut down buttons, with confirmation, wired to `scripts/wol/` |

The electricity rate is a **textbox at the top of the dashboard**
(`$rate_usd_kwh`, default `0.24`). Change it and every cost panel recalculates
instantly — no restart, no edit to any file. That is deliberate: Puerto Rico
rates move often.

---

## ⚠️ About the energy numbers

**The power figures are modelled, not measured.** There is no wattmeter in the
loop. Each node's draw is estimated as:

```
P = P_idle + (P_max − P_idle) × CPU_utilization
```

The `P_idle` / `P_max` constants live in
`prometheus/rules/power-model.yml` and are currently **documented estimates
based on hardware class, not measurements**. Expect **±20–40% error**, worst on
Aery (its draw is dominated by disks, which CPU utilization does not predict).

Treat the dashboard as a good *relative* comparison between nodes and over time.
Before quoting an absolute dollar figure to anyone, calibrate: put one node on a
metering smart plug (~$15), read its real idle and loaded watts, and update the
two constants. Repeat per node, reusing the same plug.

Sleeping nodes emit no metrics, so they contribute **zero** rather than a
phantom idle draw. This is what makes the on-demand nodes look cheap — correctly.

---

## Install

### Which machine runs what

Two different roles — this trips people up:

| Step | Runs from | Why |
| --- | --- | --- |
| `ansible-playbook monitoring.yml` | **Any control machine** with SSH to the fleet — Sadida is a fine choice | Ansible pushes to the nodes over SSH; it does not matter where it is launched from |
| `docker compose up` in `monitoring/` | **Ocra only** | Ocra is always on. If the dashboard lived on Sadida and Sadida went down, the "wake" button would be gone exactly when needed |

So: clone the repo wherever you want to drive Ansible from, but the stack itself
must be brought up on Ocra.

### 0. Prerequisites on the control machine

```bash
sudo apt install -y ansible git
git clone <your-repo> HomeLab_Architecture && cd HomeLab_Architecture

# Inventory: real IPs and MACs (this file is gitignored)
cp ansible/inventory/hosts.yml.example ansible/inventory/hosts.yml
$EDITOR ansible/inventory/hosts.yml

# Confirm every node answers before going further
ansible -i ansible/inventory/hosts.yml monitored -m ping
```

### 1. Deploy node_exporter to every node (Ansible)

```bash
# On-demand nodes must be awake to be provisioned
./scripts/wol/wake.sh all

ansible-playbook ansible/playbooks/monitoring.yml
```

This installs `node_exporter` as a hardened systemd service on Sadida, Ocra,
Aery, Sram, Xelor and Sacro, plus `lm-sensors` so temperature metrics appear.

> Aery used to be a Synology NAS and needed a separate SNMP path. Now that it
> is Debian, it takes the same `node_exporter` as everything else.

### 2. Prepare Control API credentials (on Ocra)

The Control API needs to reach nodes to shut them down and to drain them from
k3s first.

```bash
cd ~/HomeLab_Architecture/monitoring
mkdir -p secrets

# Dedicated SSH key — do not reuse your personal one
ssh-keygen -t ed25519 -f ./secrets/control_id_ed25519 -N ''

# Authorize it on the nodes that may be powered off
for n in sram xelor sacro; do
  ssh-copy-id -i ./secrets/control_id_ed25519.pub seth@$n
done

# Avoid first-connect host key prompts
ssh-keyscan sram xelor sacro > ./secrets/known_hosts

# kubeconfig for draining (edit server: to Sadida's tailnet address)
scp sadida:/etc/rancher/k3s/k3s.yaml ./secrets/kubeconfig
```

### 3. Configure and launch

```bash
cp .env.example .env
# Fill GRAFANA_ADMIN_PASSWORD and CONTROL_API_TOKEN:
#   openssl rand -base64 24
#   openssl rand -hex 32
$EDITOR .env

sudo docker compose up -d --build
```

### 4. Verify

```bash
sudo docker compose ps
curl -s localhost:9090/-/healthy                       # Prometheus
curl -s localhost:8090/health                          # Control API
curl -s localhost:9090/api/v1/targets | grep -c '"up"' # nodes being scraped
```

Then open Grafana at `http://ocra.stegosaurus-panga.ts.net:3000` → folder
**HomeLab** → dashboard **HomeLab — Nodes, Power & Control**.

---

## Control API

Runs with **host networking**, which is required: Wake-on-LAN magic packets are
UDP broadcasts to `192.168.68.255`, and a bridged container cannot broadcast
onto the LAN.

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/health` | Liveness + effective config. No auth. |
| `GET` | `/metrics` | Prometheus counters for this service. No auth. |
| `GET` | `/nodes` | Allowlist and per-node permissions. |
| `POST` | `/control/wake/:node` | Sends the magic packet. |
| `POST` | `/control/shutdown/:node` | Drains from k3s, then powers off. Add `?skip_drain=true` to skip. |
| `GET` | `/control/status` | Output of `scripts/wol/status.sh`. |

```bash
curl -X POST -H "Authorization: Bearer $CONTROL_API_TOKEN" \
  http://ocra.stegosaurus-panga.ts.net:8090/control/wake/xelor
```

### Safety model

Four layers, in order:

1. **No shell strings, ever.** Every script call uses `execFile` with an argv
   array, so a node name cannot be interpreted as a command.
2. **Hardcoded allowlist.** Only the six known node names are accepted; anything
   else is rejected before execution.
3. **Shutdown is opt-in per node.** Blocked by default for:
   - `sadida` — k3s control-plane and the Ollama GPU host
   - `ocra` — **runs Prometheus, Grafana and the Control API itself**; powering
     it off from its own dashboard would kill the dashboard mid-request
   - `aery` — Nextcloud and shared storage that other nodes mount

   Override deliberately with `CONTROL_API_ALLOW_SHUTDOWN_<NODE>=true`.
4. **Bearer token** on every control endpoint, compared in constant time, on top
   of the service being reachable only over Tailscale.

The token is stored in the Grafana **datasource** configuration, not in the
dashboard JSON, so it stays server-side and never reaches the browser.

---

## Tests

The power model is unit-tested, because a broken PromQL join produces **no
output** rather than a wrong number — a failure mode that is easy to miss on a
dashboard.

```bash
cd monitoring/prometheus/tests
promtool test rules power-model_test.yml
```

Also useful before committing a change:

```bash
promtool check config monitoring/prometheus/prometheus.yml
promtool check rules  monitoring/prometheus/rules/*.yml
```

> Keep test files out of `prometheus/rules/` — Prometheus globs `rules/*.yml`
> and would try to load a test file as a rule file and fail to start.

---

## Layout

```
monitoring/
├── docker-compose.yaml            # Prometheus + Grafana + Control API
├── .env.example
├── prometheus/
│   ├── prometheus.yml             # scrape targets (all nodes, by MagicDNS)
│   ├── rules/power-model.yml      # ⭐ per-node watt constants — edit to calibrate
│   └── tests/power-model_test.yml # promtool unit tests
├── grafana/
│   ├── provisioning/              # datasources + dashboard provider
│   └── dashboards/homelab-control.json
└── control-api/                   # Node service wrapping scripts/wol/*
    ├── server.js
    ├── package.json
    └── Dockerfile
```

---

## Known gaps

- **Request counts are not wired yet.** The traffic you care about
  (Telegram → n8n → Hermes) lives in the automation stack, which is a separate
  repo/agent. They need to expose `/metrics` on Hermes and set
  `N8N_METRICS=true`; the scrape jobs are already written and commented out in
  `prometheus/prometheus.yml`, ready to enable.
- **No GPU watts yet.** The model has a slot for real `nvidia-smi` watts on
  Sadida and falls back to zero until the exporter is deployed (Phase 2).
- **No per-process metrics yet.** `process-exporter` is Phase 2; today you get
  node-level CPU/RAM, not a per-process breakdown.
- **Control button panel.** The wake/shutdown buttons use the Business Forms
  panel (`volkovlabs-form-panel`). The API endpoints and safety logic are tested
  end-to-end, but the panel's own option schema changes between plugin versions
  — if the buttons do not submit on first run, open the panel editor and confirm
  the request URL points at `/control/${payload.action}/${payload.node}`.
