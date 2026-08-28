#!/usr/bin/env bash
# monitoring/shelly-gen4-exporter/diag.sh
#
# One-shot terminal diagnostic for the Shelly Gen4 power plug — no need to
# dig through Grafana. Hits the device's own RPC API directly plus
# Prometheus, and prints the handful of fields that actually matter:
#
#   - Sys.GetStatus      -> uptime (a low value means it rebooted recently)
#   - Switch.GetStatus   -> live power/voltage/current/temp, output state,
#                           and any active `errors` (overvoltage, overpower,
#                           overtemp, undervoltage)
#   - Switch.GetConfig   -> autorecover_voltage_errors. This only controls
#                           whether the SWITCH re-enables itself after an
#                           over/undervoltage trip clears — it does NOT stop
#                           the device's own MCU from rebooting on a real
#                           power interruption. A low Sys.GetStatus uptime
#                           combined with autorecover already being True
#                           points at a genuine power blip to the outlet
#                           itself, not a fixable device setting.
#   - Prometheus         -> resets() on the cumulative energy counter over
#                           the last 24h, so you can tell at a glance
#                           whether the real-cost panels are trustworthy
#                           right now or still catching up after a reset.
#
# Usage:
#   ./diag.sh [shelly-url] [prometheus-url]
#
# Defaults: shelly-url is read from SHELLY_PSU_URL in ../.env if not passed
# as an argument. prometheus-url defaults to http://localhost:9090 (correct
# when run on Ocra, where both containers live).

set -uo pipefail
# Deliberately NOT -e (errexit): every network call below is a separate,
# independent diagnostic. If one hiccups (transient timeout, a container
# restarting, etc.) the rest of the report should still print instead of
# the whole script dying silently mid-way.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

SHELLY_URL="${1:-}"
PROM_URL="${2:-http://localhost:9090}"

if [[ -z "$SHELLY_URL" && -f "$ENV_FILE" ]]; then
  SHELLY_URL="$(grep -E '^SHELLY_PSU_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')"
fi

if [[ -z "$SHELLY_URL" ]]; then
  echo "Usage: $0 <shelly-url> [prometheus-url]" >&2
  echo "  (or set SHELLY_PSU_URL in monitoring/.env so it's picked up automatically)" >&2
  exit 1
fi

SHELLY_URL="${SHELLY_URL%/}"

hr() { printf '%s\n' "------------------------------------------------------------"; }

# fetch URL -> prints body on stdout, or a "[unreachable]" marker if curl
# failed or returned nothing, so callers never hand empty input to python.
fetch() {
  local url="$1"
  local body
  body="$(curl -s --max-time 5 "$url" 2>/dev/null)"
  if [[ -z "$body" ]]; then
    echo "[unreachable]"
  else
    echo "$body"
  fi
}

fetch_get() {
  local url="$1"
  shift
  local body
  body="$(curl -s -G --max-time 5 "$url" "$@" 2>/dev/null)"
  if [[ -z "$body" ]]; then
    echo "[unreachable]"
  else
    echo "$body"
  fi
}

hr
echo "Shelly device: $SHELLY_URL"
hr

echo
echo "# Sys.GetStatus -- uptime (low value = recent reboot)"
body="$(fetch "$SHELLY_URL/rpc/Sys.GetStatus")"
if [[ "$body" == "[unreachable]" ]]; then
  echo "could not reach $SHELLY_URL -- check it's powered and on the network"
else
  echo "$body" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    up = d.get('uptime')
    print(f'uptime: {up}s (~{up/3600:.1f}h)' if up is not None else 'uptime: unavailable')
    print(f\"restart_required: {d.get('restart_required')}\")
except json.JSONDecodeError:
    print('device returned a non-JSON response')
"
fi

echo
echo "# Switch.GetStatus -- live reading + any active protection errors"
body="$(fetch "$SHELLY_URL/rpc/Switch.GetStatus?id=0")"
if [[ "$body" == "[unreachable]" ]]; then
  echo "could not reach $SHELLY_URL -- check it's powered and on the network"
else
  echo "$body" | python3 -m json.tool 2>/dev/null || echo "$body"
fi

echo
echo "# Switch.GetConfig -- protection thresholds and auto-recovery"
body="$(fetch "$SHELLY_URL/rpc/Switch.GetConfig?id=0")"
if [[ "$body" == "[unreachable]" ]]; then
  echo "could not reach $SHELLY_URL -- check it's powered and on the network"
else
  echo "$body" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    auto = d.get('autorecover_voltage_errors')
    flag = '  <-- if False, enable this first' if auto is False else ''
    print(f'autorecover_voltage_errors: {auto}{flag}')
    print(f\"voltage_limit: {d.get('voltage_limit')} V   undervoltage_limit: {d.get('undervoltage_limit')} V\")
    print(f\"power_limit: {d.get('power_limit')} W   current_limit: {d.get('current_limit')} A\")
except json.JSONDecodeError:
    print('device returned a non-JSON response')
"
fi

echo
hr
echo "Prometheus: $PROM_URL"
hr

echo
echo "# Energy counter resets in the last 24h (>0 = device rebooted mid-window)"
body="$(fetch_get "$PROM_URL/api/v1/query" --data-urlencode 'query=resets(shelly_status_total_energy_watt_hours[24h])')"
if [[ "$body" == "[unreachable]" ]]; then
  echo "could not reach Prometheus at $PROM_URL -- is the container up? (try again, this can be transient)"
else
  echo "$body" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    r = d.get('data', {}).get('result', [])
    print(f'resets in last 24h: {r[0][\"value\"][1]}' if r else 'no data (target may be down)')
except json.JSONDecodeError:
    print('Prometheus returned a non-JSON response')
"
fi

echo
echo "# Exporter's own health (last poll status)"
body="$(fetch "http://localhost:8091/health")"
if [[ "$body" == "[unreachable]" ]]; then
  echo "could not reach the exporter at localhost:8091 -- is the container up?"
else
  echo "$body" | python3 -m json.tool 2>/dev/null || echo "$body"
fi
hr
