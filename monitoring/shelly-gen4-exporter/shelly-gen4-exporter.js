#!/usr/bin/env node
/**
 * HomeLab Shelly Gen4 Exporter
 *
 * A tiny stand-in for the `shellyctl` exporter (used for shelly-power.yml's
 * Gen2/Plus plug), needed because shellyctl does not support Gen4 devices:
 * its device-spec resolver has no entry for whatever `app` string a Gen4
 * device reports, and fails outright with "unable to resolve device `app`
 * to spec: unknown `app`". shellyctl's own README describes itself as a
 * Gen2 client, last meaningfully developed in Feb 2024 — well before Gen4
 * hardware existed — and no actively-maintained alternative with confirmed
 * Gen4 support was found either (checked 2026-08).
 *
 * The good news: Gen4 devices still speak the SAME open Gen2+ RPC API
 * (confirmed via shelly-api-docs.shelly.cloud/gen2/Devices/Gen4/...) — this
 * is a components/RPC evolution, not a protocol break. So rather than wait
 * on upstream Gen4 support, this polls that RPC endpoint directly:
 *
 *   GET {SHELLY_PSU_URL}/rpc/Switch.GetStatus?id={SHELLY_SWITCH_ID}
 *
 * and re-exposes the fields Prometheus already expects, on scrape, no
 * background polling loop needed (the RPC call itself takes well under a
 * second and Prometheus's own scrape_timeout already bounds this).
 *
 * IMPORTANT: the metric name below (shelly_status_instantaneous_active_
 * power_watts) is deliberately IDENTICAL to the one shellyctl used to
 * produce. monitoring/prometheus/rules/shelly-power.yml's `lab:power_watts:
 * measured` recording rule sums exactly that metric name — matching it
 * means this exporter is a drop-in replacement with ZERO changes needed to
 * the recording rules, the outage-detection logic, or any dashboard panel.
 *
 * Outage detection depends on a specific behavior, preserved here on
 * purpose: when the device is unreachable (e.g. a REAL power outage on the
 * circuit this plug measures), this exporter's OWN /metrics endpoint still
 * responds 200 (so Prometheus's `up{job="shelly-power"}` stays 1 — this
 * container is fine, it's the physical device that's gone dark) but emits
 * NO shelly_status_* lines at all. That absence of a sample is what
 * `lab:grid_status:up` and the "Grid outage history" panel key off of — see
 * the comments in shelly-power.yml for the full reasoning.
 */

"use strict";

const http = require("http");

// ── Configuration ───────────────────────────────────────────────────
const PORT = parseInt(process.env.SHELLY_GEN4_EXPORTER_PORT || "8080", 10);
// May include http://user:pass@host for devices with RPC auth enabled (see
// .env.example's SHELLY_PSU_URL comment). No trailing slash required.
const RAW_TARGET_URL = process.env.SHELLY_PSU_URL || "";
const SWITCH_ID = parseInt(process.env.SHELLY_GEN4_EXPORTER_SWITCH_ID || "0", 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.SHELLY_GEN4_EXPORTER_TIMEOUT_MS || "5000", 10);

if (!RAW_TARGET_URL) {
  console.error("SHELLY_PSU_URL is required (e.g. http://192.168.68.50 or http://admin:password@192.168.68.50 if RPC auth is enabled)");
  process.exit(1);
}

let targetUrl;
try {
  targetUrl = new URL(RAW_TARGET_URL);
} catch (err) {
  console.error(`SHELLY_PSU_URL is not a valid URL: ${err.message}`);
  process.exit(1);
}

// ── State (for /health and debugging) ──────────────────────────────
const state = { lastPollAt: null, lastPollOk: null, lastError: null };
const counters = { polls_total: 0, errors_total: 0 };

// ── RPC client ──────────────────────────────────────────────────────
/**
 * Calls Switch.GetStatus on the device. Resolves with the parsed status
 * object, or rejects with an Error — callers decide what "no data" means
 * for their own output (see renderMetrics below), this function only ever
 * reports success/failure of the RPC call itself.
 */
function fetchSwitchStatus() {
  return new Promise((resolve, reject) => {
    const path = `/rpc/Switch.GetStatus?id=${SWITCH_ID}`;
    const headers = {};
    // Basic auth via URL userinfo. Node's http module does not do this
    // automatically (unlike a browser navigating to the URL directly), so
    // it is built here explicitly.
    if (targetUrl.username) {
      const creds = Buffer.from(`${decodeURIComponent(targetUrl.username)}:${decodeURIComponent(targetUrl.password)}`).toString("base64");
      headers.Authorization = `Basic ${creds}`;
    }

    const req = http.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path,
        method: "GET",
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`RPC returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Bad JSON from device: ${err.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", function () {
      this.destroy(new Error(`RPC call timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.end();
  });
}

// ── Metrics rendering ───────────────────────────────────────────────
function renderDeviceMetrics(status) {
  const lines = [];
  const push = (help, type, name, value) => {
    if (value === undefined || value === null || !Number.isFinite(value)) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${value}`);
  };

  // Deliberately the SAME name shellyctl used — see the file header comment.
  // shelly-power.yml's lab:power_watts:measured sums exactly this metric.
  push(
    "Instantaneous active power draw, in watts (Switch.GetStatus apower).",
    "gauge",
    "shelly_status_instantaneous_active_power_watts",
    status.apower
  );
  push("Line voltage, in volts (Switch.GetStatus voltage).", "gauge", "shelly_status_voltage_volts", status.voltage);
  push("Line current, in amperes (Switch.GetStatus current).", "gauge", "shelly_status_current_amperes", status.current);
  push("Line frequency, in hertz (Switch.GetStatus freq).", "gauge", "shelly_status_frequency_hertz", status.freq);
  push(
    "1 if the switch output is currently on, 0 if off (Switch.GetStatus output).",
    "gauge",
    "shelly_status_output",
    typeof status.output === "boolean" ? (status.output ? 1 : 0) : undefined
  );
  if (status.aenergy && typeof status.aenergy.total === "number") {
    push(
      "Cumulative active energy since last reset, in watt-hours (Switch.GetStatus aenergy.total).",
      "counter",
      "shelly_status_total_energy_watt_hours",
      status.aenergy.total
    );
  }
  if (status.temperature && typeof status.temperature.tC === "number") {
    push(
      "Device temperature, in Celsius (Switch.GetStatus temperature.tC).",
      "gauge",
      "shelly_status_temperature_celsius",
      status.temperature.tC
    );
  }

  return lines;
}

function renderSelfMetrics() {
  return [
    "# HELP homelab_shelly_gen4_exporter_polls_total RPC polls attempted against the device.",
    "# TYPE homelab_shelly_gen4_exporter_polls_total counter",
    `homelab_shelly_gen4_exporter_polls_total ${counters.polls_total}`,
    "# HELP homelab_shelly_gen4_exporter_errors_total RPC polls that failed (device unreachable, bad response, etc).",
    "# TYPE homelab_shelly_gen4_exporter_errors_total counter",
    `homelab_shelly_gen4_exporter_errors_total ${counters.errors_total}`,
    "# HELP homelab_shelly_gen4_exporter_last_poll_success 1 if the most recent poll succeeded.",
    "# TYPE homelab_shelly_gen4_exporter_last_poll_success gauge",
    `homelab_shelly_gen4_exporter_last_poll_success ${state.lastPollOk ? 1 : 0}`,
  ];
}

// ── HTTP server ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "ok",
        target: `${targetUrl.protocol}//${targetUrl.hostname}${targetUrl.port ? ":" + targetUrl.port : ""}`,
        switch_id: SWITCH_ID,
        last_poll_at: state.lastPollAt,
        last_poll_ok: state.lastPollOk,
        last_error: state.lastError,
      })
    );
  }

  if (req.method === "GET" && url.pathname === "/metrics") {
    counters.polls_total += 1;
    let deviceLines = [];
    try {
      const status = await fetchSwitchStatus();
      deviceLines = renderDeviceMetrics(status);
      state.lastPollOk = true;
      state.lastError = null;
    } catch (err) {
      // Deliberately NOT a 5xx response — see the file header comment on why
      // this scrape must still succeed while simply omitting device metrics.
      counters.errors_total += 1;
      state.lastPollOk = false;
      state.lastError = err.message;
      console.error(`Poll failed: ${err.message}`);
    }
    state.lastPollAt = new Date().toISOString();

    const body = [...renderSelfMetrics(), ...deviceLines].join("\n") + "\n";
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    return res.end(body);
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// ── Startup ─────────────────────────────────────────────────────────
console.log(`HomeLab Shelly Gen4 Exporter starting.`);
console.log(`  Target:    ${targetUrl.protocol}//${targetUrl.hostname}${targetUrl.port ? ":" + targetUrl.port : ""} (switch:${SWITCH_ID})`);
console.log(`  Listening: 0.0.0.0:${PORT} (/health, /metrics)`);

server.listen(PORT, "0.0.0.0");

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`Received ${sig}, shutting down.`);
    server.close(() => process.exit(0));
  });
}
