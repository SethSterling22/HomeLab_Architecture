#!/usr/bin/env python3
"""
monitoring/shelly-gen4-exporter/correlate-resets.py

Finds every reset of the Shelly's cumulative energy counter in a given
window and checks whether the CyberPower UPS (via NUT) was on-battery
(flag="OB") at that same moment. This replaces eyeballing a giant
query_range JSON matrix by hand: it prints one short table answering
"are the Shelly's reboots caused by the same grid event the UPS sees,
or something else (a loose connection, a different/unprotected circuit,
a Shelly-specific fault)?"

Stdlib only, no dependencies -- same convention as the other custom
scripts in this repo (wake-proxy.js, idle-shutdown.js, etc.).

Usage:
    ./correlate-resets.py [hours] [prometheus-url]

Examples:
    ./correlate-resets.py                          # last 24h, localhost:9090
    ./correlate-resets.py 48                        # last 48h
    ./correlate-resets.py 24 http://localhost:9090
"""

import json
import sys
import time
import urllib.parse
import urllib.request

RESET_EPSILON_WH = 0.001  # ignore floating-point noise, only real drops count


def _get_json(url: str, timeout: float = 15) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.load(resp)


def query_range(prom_url: str, query: str, start: float, end: float, step: int = 30) -> dict:
    params = urllib.parse.urlencode({"query": query, "start": start, "end": end, "step": step})
    return _get_json(f"{prom_url}/api/v1/query_range?{params}")


def query_instant(prom_url: str, query: str, at: float) -> dict:
    params = urllib.parse.urlencode({"query": query, "time": at})
    return _get_json(f"{prom_url}/api/v1/query?{params}")


def main() -> int:
    hours = float(sys.argv[1]) if len(sys.argv) > 1 else 24.0
    prom_url = sys.argv[2].rstrip("/") if len(sys.argv) > 2 else "http://localhost:9090"

    end = time.time()
    start = end - hours * 3600

    try:
        data = query_range(prom_url, "shelly_status_total_energy_watt_hours", start, end, step=30)
    except Exception as exc:  # noqa: BLE001 -- this is a CLI tool, print and exit
        print(f"Could not reach Prometheus at {prom_url}: {exc}", file=sys.stderr)
        return 1

    results = data.get("data", {}).get("result", [])
    if not results:
        print(f"No shelly_status_total_energy_watt_hours data in the last {hours:.1f}h.")
        return 0

    values = results[0]["values"]  # [[ts, "value"], ...]
    resets = []
    prev_val = None
    for ts, val_str in values:
        val = float(val_str)
        if prev_val is not None and val < prev_val - RESET_EPSILON_WH:
            resets.append((ts, prev_val, val))
        prev_val = val

    if not resets:
        print(f"No resets detected in the last {hours:.1f}h.")
        return 0

    print(f"{len(resets)} reset(s) in the last {hours:.1f}h:\n")
    print(f"{'When':<21} {'Before (Wh)':>12} {'After (Wh)':>11}   UPS status nearby")
    print("-" * 72)

    for ts, before, after in resets:
        when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))
        ups_status = "no UPS data"
        try:
            ups_data = query_instant(prom_url, 'network_ups_tools_ups_status{flag="OB"}', ts)
            ups_result = ups_data.get("data", {}).get("result", [])
            if ups_result:
                ob_value = ups_result[0]["value"][1]
                ups_status = "ON BATTERY (OB)" if ob_value == "1" else "on mains (OL)"
        except Exception:  # noqa: BLE001 -- degrade gracefully per-row
            pass
        print(f"{when:<21} {before:>12.2f} {after:>11.2f}   {ups_status}")

    if len(resets) >= 2:
        gaps = [resets[i][0] - resets[i - 1][0] for i in range(1, len(resets))]
        avg_gap = sum(gaps) / len(gaps)
        min_gap, max_gap = min(gaps), max(gaps)
        last_ts = resets[-1][0]

        def fmt_hm(seconds: float) -> str:
            h, m = divmod(int(seconds // 60), 60)
            return f"{h}h{m:02d}m"

        print()
        print(
            f"Interval between resets: avg {fmt_hm(avg_gap)}  "
            f"(min {fmt_hm(min_gap)}, max {fmt_hm(max_gap)}) -- "
            f"{'irregular, treat as a rough window, not a schedule' if (max_gap - min_gap) > avg_gap * 0.5 else 'fairly consistent'}"
        )
        earliest = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(last_ts + min_gap))
        expected = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(last_ts + avg_gap))
        latest = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(last_ts + max_gap))
        print(f"Next reset projected between {earliest} and {latest} (average case: {expected})")
        if time.time() > last_ts + max_gap:
            print("(that window has already passed without a new reset showing up in this run's data)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
