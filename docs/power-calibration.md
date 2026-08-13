# Power Model Calibration — Per-Node Runbook (Optional)

> **Status: optional, not required.** Phase 3 of `docs/monitoring-stack-plan.md`
> is done via a different, simpler route: a single Shelly plug on the shared
> power strip/UPS now measures the WHOLE fleet's real watts continuously (see
> `monitoring/prometheus/rules/shelly-power.yml` and the "Grid power" row in
> the dashboard). That gives a real fleet-total number and outage detection
> with zero manual work.
>
> This runbook is still here for later, IF the per-node breakdown specifically
> (not just the fleet total) ever needs to be trustworthy — the fleet-wide
> plug can't tell you how much of the total Sadida vs. Aery is drawing.

Replaces the guessed `P_idle`/`P_max` constants in
`monitoring/prometheus/rules/power-model.yml` with real measured watts. This is
a **physical, one-time-per-node** task — it needs a metering smart plug, which
this agent cannot buy or read for you. This runbook tells you exactly what to
do and what to send back so the constants can be updated.

## What you need

One (1) energy-metering smart plug that reports instantaneous watts, e.g.:

- Shelly Plug S (~$15, has a local HTTP API — no cloud login required to read)
- TP-Link Kasa EP25 / HS110 (~$15, needs the Kasa app or a local API)
- Any plug with a wattage display works too — you just read the number by eye

You only need **one**. Move it from node to node; do them one at a time.

## Current guessed constants (what you're replacing)

| Node | P_idle (W) | P_max (W) | Class |
| --- | --- | --- | --- |
| Sadida | 55 | 180 | Desktop CPU + Proxmox host, excludes GPU (measured separately) |
| Ocra | 15 | 65 | Small always-on box |
| Aery | 35 | 90 | Nextcloud + spinning disks |
| Sram | 20 | 90 | Bare-metal k3s worker |
| Xelor | 20 | 95 | On-demand worker |
| Sacro | 20 | 95 | On-demand worker |

These are documented guesses based on hardware class, not measurements — see
the comments in `power-model.yml`. Expect real numbers to differ, sometimes
significantly (Aery especially, since its guess ignores disk draw entirely).

## Procedure (repeat per node)

1. **Plug the node into the meter.** Let it run normally, nothing else
   plugged into the same meter.

2. **Idle reading.** Make sure nothing heavy is running (`top`/`htop` should
   show near-0% CPU). Wait 2–3 minutes for the reading to settle, then record
   the watts shown — this is `P_idle`.

3. **Install stress-ng** (one-time per node, if not already present):

   ```bash
   sudo apt install -y stress-ng
   ```

4. **Load reading.** Run a full-CPU stress test for 90 seconds and read the
   meter near the end of that window, once the number has stabilized:

   ```bash
   stress-ng --cpu 0 --timeout 90s --metrics-brief
   ```

   `--cpu 0` means "use every core available" — no need to know the core
   count ahead of time. Read the meter around the 60–75s mark; note the
   number, this is `P_max`.

5. **Record both numbers** in the table below and move the plug to the next
   node.

## Suggested order

Do Sadida first — it has the widest idle/max range (55–180W) and the biggest
potential correction to the fleet total. Aery is the second priority: its
guess is the least trustworthy (disk-dominated draw, which CPU stress doesn't
exercise at all — that's a known limitation, not a bug in this procedure).

| Priority | Node | Why |
| --- | --- | --- |
| 1 | Sadida | Widest range, most impact on fleet total |
| 2 | Aery | Guess is least trustworthy (disk-bound, not CPU-bound) |
| 3 | Sram | 24/7, meaningful contribution to always-on baseline |
| 4 | Ocra | Smallest range, lowest priority |
| 5 | Xelor / Sacro | On-demand — mostly contribute 0W already while asleep |

## Results — fill this in and send it back

| Node | Measured P_idle (W) | Measured P_max (W) | Notes |
| --- | --- | --- | --- |
| Sadida | | | |
| Ocra | | | |
| Aery | | | |
| Sram | | | |
| Xelor | | | |
| Sacro | | | |

Once you have even one node's numbers, send them over — the constants get
updated in `power-model.yml` one node at a time, no need to wait for all six.
After each update:

```bash
promtool check rules monitoring/prometheus/rules/power-model.yml
cd monitoring/prometheus/tests && promtool test rules power-model_test.yml
```

then the usual `git push` (you) → `git pull` + Prometheus reload (Ocra).

## A note on accuracy

Even calibrated, this remains a **linear CPU-utilization model** — it does not
account for disk or network I/O. That refinement is Phase 4, and depends on
this calibration being done first (tuning the shape of a model before fixing
its constants is a waste of effort). Aery will likely still be the least
accurate node afterward, since its real-world draw is dominated by spinning
disks that idle/load CPU readings do not capture — Phase 4 is where that gets
addressed, by folding disk I/O into the utilization term.
