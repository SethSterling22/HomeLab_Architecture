# Node Monitoring & Control Stack — Design Plan

Design plan for observability, energy estimation, and graphical power control
across every HomeLab node. This document is a **plan**, not an implementation.

## Goals (from the user)

1. Graphically power nodes **on/off** from a dashboard.
2. See **live metrics** per node: running processes, RAM, CPU, temperature.
3. Count **incoming requests** hitting the stack.
4. Produce **usage statistics** per node.
5. Estimate **energy consumption** to (a) quote the cost of running the lab and
   (b) derive **energy-efficiency** statistics.

## Locked decisions

| Decision | Choice |
| --- | --- |
| Metrics/visualization stack | **Grafana + Prometheus** |
| Energy measurement | **Software estimation** (no metering hardware, for now) |
| Power on/off control | **Inside Grafana** where possible; a custom panel only for gaps |
| Coverage | **All nodes** — all are Debian-based now, including **Aery** |
| Cost currency | **USD**, tariff editable at runtime (Puerto Rico rates move often) |
| Exporter install | **Ansible** (`ansible/playbooks/monitoring.yml`) |
| Deployment | **Ocra, via Docker Compose** (24/7, independent of the k3s cluster) |

### Why Ocra + Docker (not k3s) for the monitoring server

Ocra is always on. If Prometheus/Grafana lived in k3s and the serving node were
asleep, the dashboard (and the WOL "wake" button) would be unavailable exactly
when you need it. Running the server on Ocra keeps monitoring and control alive
even when Sadida-hosted workloads or the on-demand nodes are down. The k3s
`monitoring/` namespace stays as an optional future route.

---

## Architecture overview

```
                     ┌─────────────────────────── Ocra (24/7) ───────────────────────────┐
   scrapes  ┌──────► │  Prometheus  ─►  recording rules (watts, kWh, cost, efficiency)     │
            │        │      │                                                              │
 each node  │        │      └────►  Grafana  ──(Button Panel plugin)──►  Control API       │
 exporters ─┤        │                                              (wraps scripts/wol/*)  │
            │        └─────────────────────────────────────────────────────────────────────┘
            │
   ┌────────┴───────────────────────────────────────────────┐
   │ node_exporter + process-exporter on every Linux node    │
   │ nvidia GPU exporter on Sadida (real GPU watts)          │
   └─────────────────────────────────────────────────────────┘
```

---

## Data collection layer (per node)

| Node | OS | Exporters | Notes |
| --- | --- | --- | --- |
| Sadida | Proxmox (Debian) | `node_exporter`, `process-exporter`, **nvidia GPU exporter** | GPU exporter gives **real watts** from `nvidia-smi` — the one hard power number we get for free. |
| Ocra | Debian | `node_exporter`, `process-exporter` | Also hosts the monitoring server itself. |
| Aery | Debian | `node_exporter`, `process-exporter` | 24/7 Nextcloud + storage node. **Rebuilt from Synology DSM to plain Debian**, so it now takes the same `node_exporter` as every other node — no SNMP special case, and its disks/temps come through the standard collectors. |
| Sram | Debian | `node_exporter`, `process-exporter` | 24/7 worker. |
| Xelor | Debian | `node_exporter`, `process-exporter` | On-demand; Prometheus will mark it `down` when asleep (this itself feeds uptime/availability stats). |
| Sacro | Debian | `node_exporter`, `process-exporter` | On-demand, same as Xelor. |

Metric coverage this gives you:

- **CPU / RAM / load / network / disk I/O** — `node_exporter`.
- **Temperature** — `node_exporter` hwmon collector (lm-sensors) on every
  node; GPU temp from the nvidia exporter on Sadida.
- **Top processes (CPU/mem)** — `process-exporter` (plain `node_exporter` does
  not do per-process; this is the piece that answers "what's running").
- **Requests** — see the cross-repo note below.

### Requests count — cross-repo coordination

The request volume you care about is traffic into the automation stack (Telegram
→ n8n → Hermes), which now lives in **`Productivity_Tools/` (the other agent's
repo)**. To graph it, that stack must expose the numbers:

- **Hermes gateway** — add a `/metrics` Prometheus endpoint (a counter per
  `POST /tool/:name`). Small change on their side.
- **n8n** — has built-in Prometheus metrics (`N8N_METRICS=true`).
- **k3s ingress (Traefik)** — if any traffic is routed there, Traefik exports
  request metrics natively.

**Action for the automation agent (not this repo):** expose `/metrics` on Hermes
and set `N8N_METRICS=true`. We scrape it from here; we do not instrument it here.

---

## Energy estimation — honest design

Software-only estimation has real limits; being upfront so the "cost quotation"
is trustworthy:

- There is no per-node wattmeter. We *model* per-node power, we don't measure
  it individually (except the GPU). There IS a real wattmeter at the fleet
  level now — a Shelly plug on the shared power strip/UPS — which measures
  the whole rack's true draw and is compared live against the modelled total
  (`lab:power_watts:measured` vs `lab:power_watts:total`, see
  `monitoring/prometheus/rules/shelly-power.yml`). It just cannot attribute
  that total to a single node.
- **RAPL / `scaphandre`** on Intel/AMD reports **CPU-package energy only** — not
  RAM, disks, fans, or PSU conversion losses. On a whole machine that can miss
  30–50% of real draw.
- The **GPU (RTX 3050)** is the exception: `nvidia-smi` reports real watts.
- **Aery** now runs Debian, so it is no longer a black box — but it is still a
  storage node whose draw is dominated by **spinning disks**, which CPU
  utilization does not predict well. Expect its estimate to be the least
  accurate of the fleet until calibrated.

### Proposed model

Per node, estimate instantaneous power as:

```
P_node(t) = P_idle + (P_max − P_idle) × utilization(t)   [+ P_gpu_real(t) on Sadida]
```

- `utilization(t)` — a blend of CPU load (and optionally disk/net) from
  `node_exporter`, normalized 0–1.
- `P_idle`, `P_max` — per-node constants. Bootstrap them from CPU TDP + platform
  baselines (documented assumptions), then refine.
- On Sadida, add the **measured** GPU watts on top of the CPU/platform estimate.

Prometheus **recording rules** turn `P_node(t)` into:

- **kWh** per node (integrate watts over time).
- **Cost** = kWh × tariff, in **USD**. The tariff is a **Grafana textbox
  variable** (`$rate_usd_kwh`), editable straight from the dashboard header —
  Puerto Rico's LUMA rate moves often, so it is never baked into the config.
- **Efficiency** metrics: kWh/day per node, **kWh per 1k requests served**,
  watts per active CPU-core-hour, and a lab-wide cost/day and cost/month.

### Accuracy & the cheap upgrade path

A pure software model is typically **±20–40%**, worst on Aery. Two hardware
options, not mutually exclusive:

- **Fleet-wide real measurement (done — Phase 3):** a single Shelly Gen2/Plus
  plug on the shared power strip/UPS measures the whole rack's true draw
  continuously. It cannot attribute that total to a single node, but it
  validates the model's total and gives an outage signal for free, with zero
  manual measurement work. This is what's deployed today.
- **Per-node calibration (optional, `docs/power-calibration.md`):** move one
  metering smart plug from node to node, read idle/loaded watts with
  `stress-ng`, and plug the two constants into `power-model.yml` per node.
  Gives per-node accuracy the fleet-wide plug cannot. Do this later only if
  the per-node breakdown (not just the fleet total) needs to be trustworthy.
- **Permanent per-node accuracy (further upgrade, later):** one metered plug
  *per node*, exporting continuously — the gold standard, but six plugs
  instead of one.

All three are additive — the software model works today; each hardware step
only improves it.

---

## Control layer — power on/off from Grafana

Grafana can host action buttons via the **Button Panel** plugin (or the newer
Business Actions/Forms panels). A button issues an HTTP call; it does **not** run
shell commands itself. So we add a tiny control service:

- **Control API** — a small authenticated HTTP service on Ocra that wraps the
  **existing** `scripts/wol/` helpers already in this repo:
  - `wake.sh <node>` → magic packet (power on).
  - `shutdown.sh <node>` → drain from k3s + graceful power off.
  - `status.sh` → node + Ollama status (also feeds a live state badge).
- **Flow:** Grafana Button Panel → `POST /control/wake/{node}` (token) →
  Control API → runs the WOL script → returns result → Grafana shows feedback.
- **Security:** token/basic auth, bound to the Tailscale interface only,
  strict node allowlist, actions limited to wake/shutdown/status. Ocra already
  sits on Tailscale and can reach every node by MagicDNS.

This control layer is **infrastructure** — it wraps WOL scripts that already live
in this repo, so it belongs here.

### Idle auto-shutdown (autonomous, on top of the Control API)

A separate daemon (`monitoring/idle-shutdown/`) watches per-node network
traffic and calls the Control API's own shutdown endpoint once a node has
been idle past a configurable timeout — no human click involved. Because it
acts autonomously rather than on a person's explicit request, it carries
extra safety layers beyond what the button-driven Control API needs:
dry-run by default, an explicit per-node opt-in list independent of the
Control API's own allowlist, and idleness evaluated across the FULL timeout
window rather than as an average (so a real-but-brief burst of activity
can't be smoothed away). See `monitoring/README.md`, section "Idle
auto-shutdown", for the full safety model and the Aery-specific
Wake-on-LAN verification required before enabling it there.

### What Grafana can't do cleanly → optional custom panel

Start with Grafana + Button Panel. Add a small custom web panel only for gaps
that Grafana handles poorly:

- Confirmation dialogs before shutdown ("are you sure?").
- Killing a specific process on a node.
- An interactive cost calculator with an editable tariff + date range and an
  exportable report.

Recommendation: don't build the custom panel up front; add it only if a concrete
gap remains once the Control API is in daily use. As shipped, the Business Forms
panel already covers the confirmation dialog, and the editable `$rate_usd_kwh`
variable covers the tariff side of the cost calculator.

---

## Phased roadmap

| Phase | Deliverable | Status | Depends on |
| --- | --- | --- | --- |
| **0** | Prometheus + Grafana on Ocra (Docker Compose); `node_exporter` on all nodes via Ansible; base CPU/RAM/temperature/availability dashboard; first-pass power model with an editable USD tariff. | ✅ Done — `monitoring/` | — |
| **1** | Control API on Ocra wrapping `scripts/wol/*` + Grafana buttons for wake/shutdown/status. | ✅ Done — `monitoring/control-api/` | 0 |
| **2** | `process-exporter` (per-process CPU/memory — "what is running") + nvidia GPU exporter on Sadida (**real** GPU watts, the only measured power in the model). | ✅ Done — `ansible/playbooks/monitoring.yml`, `monitoring/prometheus/prometheus.yml`, dashboard panels | 0 |
| **3** | **Real measurement.** A Shelly Gen2/Plus smart plug on the shared power strip/UPS gives real fleet-wide watts (`lab:power_watts:measured`) to compare against the model, plus outage detection — no per-node stress testing needed. | ✅ Done — `monitoring/prometheus/rules/shelly-power.yml`, dashboard row "Grid power". Per-node calibration (`docs/power-calibration.md`) remains available if per-node numbers are ever wanted instead of a fleet total. | 0 |
| **4** | Refined power model (factor in disk and network I/O, which matter for Aery) + efficiency dashboard: kWh per 1k requests, watts per active core-hour, month-over-month comparison. | Open | 2, 3 |

**Do Phase 3 before Phase 4.** Refining the maths of a model whose constants are
guesses is polishing sand — calibration buys far more accuracy for far less work.

### Removed

**Synology SNMP for Aery** was a planned phase. It is **cancelled**: Aery was
rebuilt from Synology DSM into a plain Debian node running Nextcloud, so it is
covered by the standard `node_exporter` path in Phase 0. No SNMP exporter, no
separate dashboard, no special case anywhere in the config.

> Note: phases were renumbered when that step was removed. What earlier drafts
> of this document called phases 4, 1, 5 and 3 are now 1, 2, 3 and 4.

---

## Open items to confirm before building

1. ~~Electricity tariff & currency~~ — resolved: USD, editable at runtime via the
   `$rate_usd_kwh` dashboard variable.
2. ~~Enable SNMP on Aery~~ — no longer applicable (Aery is Debian now).
3. ~~GPU exporter choice on Sadida~~ — resolved: `nvidia_gpu_exporter`
   (lighter than DCGM, sufficient for a single consumer GPU). Deployed in
   Phase 2.
4. Confirm the automation agent will expose Hermes `/metrics` and enable
   `N8N_METRICS` so request counts can be scraped. The scrape jobs are already
   written and commented out in `monitoring/prometheus/prometheus.yml`.
5. **Per-node `P_idle` / `P_max` constants** currently use documented estimates
   in `monitoring/prometheus/rules/power-model.yml`. Calibrating them (Phase 3)
   is the single highest-value accuracy improvement available.
