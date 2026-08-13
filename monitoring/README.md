# Monitoring & Node Control

Prometheus + Grafana + a small Control API, running on **Ocra**. Gives you one
page to see the fleet's health and energy cost, and to power nodes on and off.

Implements **Phases 0, 1, 2 and 3** of `docs/monitoring-stack-plan.md`.

## What you get

| | |
| --- | --- |
| **Status** | Online/offline badge per node (Xelor and Sacro read offline while asleep — that is the point) |
| **Resources** | CPU, memory, temperature, availability over time |
| **Processes** | Top processes by CPU and memory, per node (`process-exporter`) |
| **GPU** | Real watts, utilization, temperature and memory on Sadida's RTX 3050 (`nvidia_gpu_exporter`) — the one non-modelled power number in the stack |
| **Energy** | Estimated watts per node, kWh and **USD cost** over any time range, projected monthly cost |
| **Grid power** | Real measured watts for the WHOLE fleet from a Shelly smart plug, compared live against the software model, plus outage detection (Phase 3) |
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
The same run also installs `process-exporter` (per-process CPU/memory) on all
six nodes, and `nvidia_gpu_exporter` (real GPU watts) on Sadida only — both
are Phase 2 and are already in this playbook, no separate command needed.

> Aery used to be a Synology NAS and needed a separate SNMP path. Now that it
> is Debian, it takes the same `node_exporter` as everything else.

> `nvidia_gpu_exporter` requires `nvidia-smi` to already work on Sadida (it
> wraps the CLI). Since Ollama already runs on Sadida with GPU access, this
> should already be the case — the playbook fails fast with a clear error if
> not.

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

### 2b. Set up the Shelly power meter (Phase 3, optional but recommended)

A Shelly Gen2/Plus smart plug, wired into the wall outlet feeding the shared
power strip/UPS all the compute nodes plug into, gives you REAL measured
wattage for the whole fleet at once — no per-node calibration needed (see
`docs/power-calibration.md` for that alternative if you ever want per-node
numbers instead of a fleet total).

1. Wire the Shelly in: wall outlet → Shelly plug → power strip/UPS → nodes.
2. Give it a **static LAN IP or DHCP reservation** — the exporter config
   depends on this not changing.
3. Confirm Ocra is on a **separate circuit/UPS** from the monitored nodes.
   This is what makes outage detection real-time: when the strip loses
   power, the Shelly goes fully dark, but Ocra (and Prometheus) keep
   running and keep noticing. If Ocra shares the same circuit, you only get
   a retrospective gap in the graphs once everything reboots — still useful,
   just not a live signal.
4. Set `SHELLY_PSU_URL` in `.env` (see step 3 below):
   `http://<shelly-ip>/` or `http://admin:<password>@<shelly-ip>/` if RPC
   auth is enabled on the device.

### 3. Configure and launch

```bash
cp .env.example .env
# Fill GRAFANA_ADMIN_PASSWORD, CONTROL_API_TOKEN and SHELLY_PSU_URL:
#   openssl rand -base64 24
#   openssl rand -hex 32
$EDITOR .env

sudo docker compose up -d --build
```

### 4. Verify

```bash
sudo docker compose ps
curl -s localhost:9090/-/healthy                          # Prometheus
curl -s localhost:8090/health                             # Control API
curl -s localhost:8091/metrics | grep shelly_status_ | head # Shelly exporter
curl -s localhost:8092/health                                # idle-shutdown daemon
curl -s localhost:9090/api/v1/targets | grep -o '"job":"[^"]*"' | sort -u
```

The last command should list `nodes`, `process-exporter`, `nvidia-gpu-exporter`,
`control-api`, `prometheus`, `shelly-power` and `idle-shutdown`.

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

## Idle auto-shutdown

A daemon (`idle-shutdown`) watches per-node network traffic and calls the
Control API's shutdown endpoint once a node has been idle — near-zero
combined rx+tx traffic — for longer than its configured timeout. Nodes wake
back up the normal way, via WOL, either manually from the dashboard or the
next time you need them.

**Safe by construction, in layers:**

1. **Dry-run by default.** `IDLE_SHUTDOWN_DRY_RUN=true` until you explicitly
   set it to `false` in `.env`. In dry-run it only logs what it would do and
   exposes that as a metric — nothing is ever powered off.
2. **Explicit node allowlist.** `IDLE_SHUTDOWN_NODES` (e.g. `aery,sram,xelor`)
   — a node not listed is never evaluated at all, independent of anything
   else.
3. **Idleness must hold for the WHOLE window, not on average.** A 5-minute
   burst of real traffic partway through a 2-hour idle window is not
   averaged away — see the comment above `trafficBps()` in
   `idle-shutdown/idle-shutdown.js` if you want the exact PromQL reasoning.
4. **No data ⇒ leave it alone.** If Prometheus has nothing for a node (it's
   already off, or genuinely unreachable), that is never treated as "idle" —
   only a confirmed low-traffic reading counts.
5. Reuses the Control API's own shutdown path — same drain-from-k3s, same
   per-node allowlist, same bearer token. This daemon adds no new SSH or WOL
   surface; it only decides *when* to call something that already exists.

### ⚠️ Before enabling Aery specifically

Aery's shutdown is blocked by default in the Control API (it hosts Nextcloud
and shared storage — see `control-api/server.js`). Setting
`CONTROL_API_ALLOW_SHUTDOWN_AERY=true` lifts that block. **Do this only
after verifying Wake-on-LAN actually wakes Aery back up** — a protected node
that cannot wake itself back up is a self-inflicted outage, not a power
saving.

**Aery originally failed to wake from either a full poweroff or suspend.**
Root cause: the mainline `alx` driver (Aery's Qualcomm Atheros QCA8171 NIC)
never implemented WOL support upstream — `ethtool` didn't even report
`Supports Wake-on`/`Wake-on` lines for it, and refused `ethtool -s <iface>
wol g` outright. This was a DRIVER bug, and it was fixable — see
`docs/aery-wol-alx-fix.md` for the DKMS patch
([AndiWeiss/alx-wol](https://github.com/AndiWeiss/alx-wol)) that fixed it.
Status: **fully fixed and confirmed.** Both a suspend+WOL round-trip (woke in
8s) and a full-poweroff+WOL round-trip (woke in 42s) succeeded, rejoining k3s
automatically each time. `scripts/wol/shutdown.sh` now uses the normal
`shutdown -h now` path for Aery, same as every other non-exempted node — no
suspend workaround needed anymore.

**Sacro needs the same `systemctl suspend` exemption, but for a DIFFERENT,
non-fixable reason:** confirmed via `ethtool` that its driver (`r8169` on a
Realtek NIC) works completely fine — WOL is already active
(`Supports Wake-on: pumbg`, `Wake-on: g`). The failure is a hardware
limitation of that specific laptop (Lenovo G50-45): the board doesn't route
standby power to the NIC when fully powered off, so no magic packet can ever
arrive in that state, regardless of driver or OS config. There is no
driver-level fix for this — `systemctl suspend` is Sacro's permanent,
correct answer, not a workaround pending a patch.

Only after a real wake round-trip succeeds should `CONTROL_API_ALLOW_SHUTDOWN_AERY`
go to `true`.

### Rollout procedure

1. Set `IDLE_SHUTDOWN_NODES` in `.env` (start with just the nodes you're
   confident about — Sram/Xelor already default to shutdown-allowed in the
   Control API).
2. Leave `IDLE_SHUTDOWN_DRY_RUN=true`. Deploy.
3. Watch it for a few days: `sudo docker compose logs -f idle-shutdown`, and
   the **Idle auto-shutdown** row on the Grafana dashboard (Mode, and the
   per-node table showing traffic/threshold/timeout/idle state live).
4. Tune `IDLE_TIMEOUT_MINUTES_<NODE>` and `IDLE_TRAFFIC_THRESHOLD_BPS` if the
   dry-run log's decisions don't match your actual usage patterns.
5. For Aery: do the WOL verification above, then set
   `CONTROL_API_ALLOW_SHUTDOWN_AERY=true`.
6. Only then set `IDLE_SHUTDOWN_DRY_RUN=false`.

### A note on what "idle" means here

This measures raw network traffic (rx+tx bytes/sec), not application-level
requests. It cannot distinguish "someone is using Nextcloud" from "some
unrelated background chatter is happening" — but the failure mode of that
imprecision is deliberately the SAFE one: a busy but unrelated process (a
backup job, an open SSH session with `top` running, etc.) keeps traffic above
the threshold and simply delays a shutdown that would otherwise have been
harmless. It never causes a *false* shutdown while something is genuinely
being used, because real use also generates traffic. The one blind spot is
low-traffic-but-still-important activity that isn't network-bound at all
(e.g., a long-running local computation with no network I/O) — if that
matters for a given node, raise its timeout accordingly or leave it off the
managed list.

---

## Tests

The power model is unit-tested, because a broken PromQL join produces **no
output** rather than a wrong number — a failure mode that is easy to miss on a
dashboard.

```bash
cd monitoring/prometheus/tests
promtool test rules power-model_test.yml
promtool test rules shelly-power_test.yml
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
├── docker-compose.yaml            # Prometheus + Grafana + Control API + Shelly exporter + idle-shutdown
├── .env.example
├── prometheus/
│   ├── prometheus.yml             # scrape targets (all nodes, by MagicDNS)
│   ├── rules/power-model.yml      # ⭐ per-node watt constants — edit to calibrate
│   ├── rules/shelly-power.yml     # real measured watts + outage detection
│   └── tests/                     # promtool unit tests (power-model, shelly-power)
├── grafana/
│   ├── provisioning/              # datasources + dashboard provider
│   └── dashboards/homelab-control.json
├── control-api/                   # Node service wrapping scripts/wol/*
│   ├── server.js
│   ├── package.json
│   └── Dockerfile
└── idle-shutdown/                 # Daemon: idle traffic -> control-api shutdown
    ├── idle-shutdown.js
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
- **Control button panel.** The wake/shutdown buttons use the Business Forms
  panel (`volkovlabs-form-panel`). The API endpoints and safety logic are tested
  end-to-end, but the panel's own option schema changes between plugin versions
  — if the buttons do not submit on first run, open the panel editor and confirm
  the request URL points at `/control/${payload.action}/${payload.node}`.
