# CyberPower UPS Monitoring via NUT (Phase 4)

> **Status: metrics only, read-only.** This adds live battery/load/status
> visibility for the CyberPower S175UC UPS to the Grafana dashboard. It does
> **not** configure any automatic shutdown behavior — that was a deliberate
> scope decision (see "Not done yet" below), not a limitation of NUT itself.

## The hardware

A CyberPower AVR UPS S175UC (1175VA / 660W, 5 UPS-backed outlets + 10
surge-only outlets). Two ports on the back are relevant, and it's worth being
precise about what each actually does, because they're easy to conflate:

- **USB port ("USB to PC")** — this is the one that matters. Plugged into a
  Linux box, it lets [NUT](https://networkupstools.org/) (Network UPS Tools)
  read the UPS's live status: on-line vs. on-battery, battery charge %,
  load %, and (if the UPS reports it) estimated runtime.
- **DB9 port** — a "dry contact closure" port for old industrial equipment
  that expects a simple on/off signal, not a data protocol. Not used here.
- **RJ45 "communication protection port"** — this is **not** a data port at
  all. It's surge protection for an Ethernet/phone cable that physically
  passes through the UPS. It exposes nothing to any monitoring software.

## Why the USB cable is plugged into Aery, not Ocra

The UPS is physically located near Sadida, Sram, Sacro and Aery — not near
Ocra. That is not actually a problem: NUT is built around a client-server
split precisely for this case.

- **The server side (`upsd`)** runs on whichever machine has the physical USB
  connection — here, **Aery**. It talks to the UPS directly and answers
  status queries.
- **The client side** can be any other machine on the network. It sends a
  plain TCP query to the server on port **3493** (NUT's own protocol, not
  HTTP) and gets the same status back, over the network.

Since Aery and Ocra are both already on the same Tailscale mesh, "over the
network" here just means "over Tailscale" — no new cabling, and no dependency
on the LAN. This is the exact same pattern already used everywhere else in
this repo (`wake.sh`, `shutdown.sh`, `prometheus.yml` — see the header comment
there) to avoid depending on things being physically near Ocra.

```
┌────────────┐   USB    ┌───────────────────────────┐
│ CyberPower  │─────────▶│ Aery                      │
│ S175UC UPS  │          │  usbhid-ups driver → upsd │
└────────────┘          │  (listens on :3493)       │
                          └─────────────┬─────────────┘
                                         │ Tailscale, TCP 3493
                                         │ (NUT's own protocol)
                                         ▼
                          ┌───────────────────────────┐
                          │ Ocra                      │
                          │  nut_exporter (:9199)     │
                          │  → Prometheus → Grafana   │
                          └───────────────────────────┘
```

## What was set up

1. **`ansible/playbooks/nut-ups.yml`** — installs `nut-server` on Aery,
   configures the `usbhid-ups` driver against the S175UC, sets
   `MODE=netserver`, opens `upsd` on `0.0.0.0:3493` (exposure limited by a
   `ufw` rule to the Tailscale range + LAN, same pattern as every exporter
   in `ansible/playbooks/monitoring.yml`), and verifies with `upsc` before
   finishing.

   ```bash
   ansible-playbook ansible/playbooks/nut-ups.yml
   ```

   The UPS's USB cable must already be plugged into Aery before running
   this. The play warns (but doesn't stop) if `lsusb` can't see it — the
   driver step will fail loudly right after if the cable really isn't
   connected.

2. **`nut-exporter` service** in `monitoring/docker-compose.yaml` — the
   [DRuggeri/nut_exporter](https://github.com/DRuggeri/nut_exporter) image,
   running on Ocra. It queries Aery's `upsd` (`NUT_UPS_HOST` in `.env`, set
   to Aery's Tailscale IP) and re-exposes the result as Prometheus metrics
   on `:9199`. No special networking needed — unlike `control-api`, this
   container only ever makes an *outbound* call, so it runs on the default
   bridge network like `shelly-exporter`.

3. **`nut-ups` scrape job** in `monitoring/prometheus/prometheus.yml`.

4. **"UPS (CyberPower S175UC)" row** in the Grafana dashboard: on-line/
   on-battery status, battery charge %, UPS load %, runtime remaining (if
   reported), a charge/load history chart, and a status-history timeline
   (same visual pattern as the existing "Grid outage history" panel).

## Deploy

```bash
# From a control machine with SSH to Aery:
ansible-playbook ansible/playbooks/nut-ups.yml

# On Ocra:
cd ~/HomeLab_Architecture
git pull
# Fill in NUT_UPS_HOST in .env if it isn't already (Aery's Tailscale IP —
# same value already used for WAKE_PROXY_TARGET_HOST)
sudo docker compose up -d --build nut-exporter prometheus
```

Verify:

```bash
# On Aery, directly:
upsc cyberpower@localhost

# On Ocra, through the exporter:
curl -s 'http://localhost:9199/ups_metrics?ups=cyberpower' | grep network_ups_tools_ups_status
curl -s http://localhost:9090/api/v1/targets | grep -A3 '"job":"nut-ups"'
```

Then check the new **"UPS (CyberPower S175UC)"** row on the dashboard.

## A note on which nodes this actually protects

This is a **different, smaller UPS** than the whole-fleet power strip the
Shelly plug measures. It only backs whatever is physically plugged into its
5 UPS-backed outlets — as placed today, that's some subset of Sadida, Sram,
Sacro and Aery, **not** Ocra (which is deliberately on its own circuit — see
`monitoring/README.md`'s note on outage detection) and not necessarily Xelor.
The dashboard's "UPS status" panel reflects *this* UPS's mains/battery state,
which is a different signal from the "Grid status" panel above it (Shelly).
If the two ever disagree, that's expected — they're monitoring different
outlets.

## Driver note

The S175UC is not individually listed on NUT's
[hardware compatibility list](https://networkupstools.org/stable-hcl.html),
but it belongs to the same USB-charging-port ("UC") CyberPower line as
several models that are confirmed to work with the `usbhid-ups` driver
(most CyberPower units are USB/HID compliant). If `upsc cyberpower@localhost`
fails to detect it after running the playbook, the next thing to try is
changing `nut_ups_driver` in `ansible/playbooks/nut-ups.yml` to `nutdrv_qx`
(a handful of older/cheaper CyberPower models need it instead) and re-running.

## Not done yet: coordinated automatic shutdown

NUT can do more than report status: `upsmon` can run on every node that cares
and trigger its own graceful shutdown once the UPS has been on battery for
too long or the battery is critically low — the same idea as
`idle-shutdown`, but triggered by a power event instead of inactivity.

This was deliberately **not** built yet — the first pass is metrics-only, so
the dashboard is trustworthy before anything is wired to act automatically
on it. If/when that's wanted, the natural integration point is the existing
Control API (`monitoring/control-api/server.js`): a small daemon watching
`network_ups_tools_ups_status{flag="OB"}` (on battery) for too long, calling
the same `/control` shutdown endpoint the dashboard buttons and
`idle-shutdown` already use — no new SSH or WOL surface, same allowlist and
bearer token, same safety model described in `monitoring/README.md`.
