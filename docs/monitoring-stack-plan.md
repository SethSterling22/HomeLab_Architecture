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
| Coverage | **All nodes**, including **Aery** (Synology NAS) |
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
            │        │  snmp_exporter (for Aery)                                           │
            │        └─────────────────────────────────────────────────────────────────────┘
            │
   ┌────────┴───────────────────────────────────────────────┐
   │ node_exporter + process-exporter on every Linux node    │
   │ nvidia GPU exporter on Sadida (real GPU watts)          │
   │ Synology SNMP agent on Aery (temps, disks, CPU, fans)   │
   └─────────────────────────────────────────────────────────┘
```

---

## Data collection layer (per node)

| Node | OS | Exporters | Notes |
| --- | --- | --- | --- |
| Sadida | Proxmox (Debian) | `node_exporter`, `process-exporter`, **nvidia GPU exporter** | GPU exporter gives **real watts** from `nvidia-smi` — the one hard power number we get for free. |
| Ocra | Debian | `node_exporter`, `process-exporter` | Also hosts the monitoring server itself. |
| Sram | Debian | `node_exporter`, `process-exporter` | 24/7 worker. |
| Xelor | Debian | `node_exporter`, `process-exporter` | On-demand; Prometheus will mark it `down` when asleep (this itself feeds uptime/availability stats). |
| Sacro | Debian | `node_exporter`, `process-exporter` | On-demand, same as Xelor. |
| Aery | Synology DSM | **SNMP** (DSM built-in agent) scraped by `snmp_exporter` | DSM is locked down — no `node_exporter`. SNMP exposes temps, disk health, RAID, CPU, fan speed. **It does NOT expose watts.** |

Metric coverage this gives you:

- **CPU / RAM / load / network / disk I/O** — `node_exporter`.
- **Temperature** — `node_exporter` hwmon collector (lm-sensors) on Linux;
  SNMP temperature OIDs on Aery; GPU temp from the nvidia exporter.
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

- There is **no true wattmeter**. We *model* power, we don't measure it (except
  the GPU).
- **RAPL / `scaphandre`** on Intel/AMD reports **CPU-package energy only** — not
  RAM, disks, fans, or PSU conversion losses. On a whole machine that can miss
  30–50% of real draw.
- **Aery (Synology)** cannot run `scaphandre`; SNMP gives no watts. Its energy
  can only be a static/model estimate.
- The **GPU (RTX 3050)** is the exception: `nvidia-smi` reports real watts.

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
- **Cost** = kWh × tariff. The tariff is a **Grafana dashboard variable** so you
  can edit €/kWh (or local currency) without redeploying.
- **Efficiency** metrics: kWh/day per node, **kWh per 1k requests served**,
  watts per active CPU-core-hour, and a lab-wide cost/day and cost/month.

### Accuracy & the cheap upgrade path

A pure software model is typically **±20–40%**, worst on Aery. To make the
numbers defensible without permanently wiring meters:

- **One-time calibration:** buy a **single** energy-metering smart plug
  (Shelly Plug / TP-Link Kasa, ~€15). Measure each node's real idle and loaded
  draw once, plug the two constants into the model, then reuse the plug on the
  next node. This calibrates the software model cheaply.
- **Permanent accuracy (optional, later):** one metered plug per node exports
  real watts continuously (Shelly has a native Prometheus/HTTP endpoint). This is
  the gold standard if the cost quotation needs to be exact.

Both are additive — the software model works today; hardware only improves it.

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

### What Grafana can't do cleanly → optional custom panel

Start with Grafana + Button Panel. Add a small custom web panel only for gaps
that Grafana handles poorly:

- Confirmation dialogs before shutdown ("are you sure?").
- Killing a specific process on a node.
- An interactive cost calculator with an editable tariff + date range and an
  exportable report.

Recommendation: don't build the custom panel up front; add it only if a concrete
gap remains after Phase 4.

---

## Phased roadmap

| Phase | Deliverable | Depends on |
| --- | --- | --- |
| **0** | Prometheus + Grafana on Ocra (Docker Compose); `node_exporter` on all Linux nodes; base CPU/RAM/temp/net dashboard. | — |
| **1** | `process-exporter` (top processes) + nvidia GPU exporter on Sadida (real GPU watts). | 0 |
| **2** | Synology SNMP enabled on Aery + `snmp_exporter` + Aery dashboard. | 0 |
| **3** | Power model + recording rules + **energy/cost/efficiency dashboard** with editable tariff variable. | 1, 2 |
| **4** | Control API on Ocra wrapping `scripts/wol/*` + Grafana Button Panel for wake/shutdown/status. | 0 |
| **5** *(optional)* | One-time smart-plug calibration; custom panel for any remaining gaps. | 3, 4 |

Phases 0/1/2/4 can proceed in parallel once Phase 0 is up. Phase 3 needs the
exporters from 1 and 2 to be meaningful.

---

## Open items to confirm before building

1. **Electricity tariff & currency** for the cost quotation (can start with a
   placeholder editable in Grafana).
2. **Enable SNMP on Aery** (Synology Control Panel → Terminal & SNMP) — required
   for NAS metrics; SNMPv3 recommended.
3. **GPU exporter choice** on Sadida (DCGM exporter vs. the lighter
   `nvidia_gpu_exporter`).
4. Confirm the automation agent will expose Hermes `/metrics` and enable
   `N8N_METRICS` so request counts can be scraped.
