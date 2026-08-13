#!/usr/bin/env node
/**
 * HomeLab Idle Shutdown Daemon
 *
 * Watches network traffic on a configured set of nodes and calls the
 * Control API's shutdown endpoint when a node has been idle (near-zero
 * traffic) for longer than its configured timeout. This is fully autonomous
 * — nobody clicks a button — so it is deliberately more conservative than
 * the Control API it drives:
 *
 *   1. DRY RUN BY DEFAULT. IDLE_SHUTDOWN_DRY_RUN must be explicitly set to
 *      "false" before this will ever power anything off. Until then it only
 *      logs what it WOULD do and exposes that as a metric.
 *   2. Idleness must hold across the ENTIRE timeout window, not just on
 *      average. A short burst of real traffic 10 minutes into a 2-hour
 *      window must NOT be averaged away — see isIdle() below.
 *   3. If Prometheus has no data for a node (already off, or genuinely
 *      unreachable), that is treated as "leave it alone", never as "idle" —
 *      a query returning nothing is not evidence of nothing happening.
 *   4. Every decision is exposed on /metrics, so the Grafana dashboard shows
 *      exactly why (or why not) a node was shut down, without re-deriving
 *      the same PromQL in two places.
 *
 * This process does NOT talk to any node directly. It only talks to
 * Prometheus (to observe) and the Control API (to act), both already
 * proven, already-tested components. It adds no new SSH/WOL surface.
 */

"use strict";

const http = require("http");

// ── Configuration ───────────────────────────────────────────────────
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://localhost:9090";
const CONTROL_API_URL = process.env.CONTROL_API_URL || "http://localhost:8090";
const CONTROL_API_TOKEN = process.env.CONTROL_API_TOKEN || "";

const PORT = parseInt(process.env.IDLE_SHUTDOWN_PORT || "8092", 10);
const CHECK_INTERVAL_SECONDS = parseInt(process.env.IDLE_CHECK_INTERVAL_SECONDS || "300", 10);

// Safe by default: nothing is ever powered off until this is set to "false".
const DRY_RUN = !/^(0|false|no|off)$/i.test(String(process.env.IDLE_SHUTDOWN_DRY_RUN ?? "true"));

// Comma-separated list of nodes this daemon is allowed to consider, e.g.
// "aery,sram,xelor". A node NOT in this list is never touched, full stop —
// this is independent of (and in addition to) the Control API's own
// per-node shutdown allowlist.
const MANAGED_NODES = String(process.env.IDLE_SHUTDOWN_NODES || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Global default threshold: sustained combined rx+tx below this many
// bytes/sec counts as "idle". ~50 KB/s comfortably clears normal Prometheus
// scrape chatter (node_exporter + process-exporter respond in a few KB every
// 15s) while sitting well under a real Nextcloud page load or file sync.
// This is a documented estimate, not a measured constant — the same honesty
// as power-model.yml's P_idle/P_max. Tune per node if you see false
// positives or negatives.
const DEFAULT_THRESHOLD_BPS = parseInt(process.env.IDLE_TRAFFIC_THRESHOLD_BPS || "51200", 10);
const DEFAULT_TIMEOUT_MINUTES = parseInt(process.env.IDLE_TIMEOUT_MINUTES_DEFAULT || "60", 10);

function perNodeInt(envPrefix, node, fallback) {
  const v = process.env[`${envPrefix}_${node.toUpperCase()}`];
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function nodeConfig(node) {
  return {
    timeoutMinutes: perNodeInt("IDLE_TIMEOUT_MINUTES", node, DEFAULT_TIMEOUT_MINUTES),
    thresholdBps: perNodeInt("IDLE_TRAFFIC_THRESHOLD_BPS", node, DEFAULT_THRESHOLD_BPS),
  };
}

// ── State (last evaluation per node, for /metrics and /status) ────────
const state = {}; // node -> { trafficBps, thresholdBps, timeoutMinutes, idle, up, lastCheck, lastError }
const counters = { checks_total: 0, actions_total: {}, errors_total: 0 };

// ── Prometheus HTTP client ─────────────────────────────────────────
function promQuery(query) {
  return new Promise((resolve, reject) => {
    const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
    http
      .get(url, { timeout: 10000 }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.status !== "success") {
              return reject(new Error(`Prometheus query failed: ${parsed.error || body}`));
            }
            resolve(parsed.data.result);
          } catch (err) {
            reject(new Error(`Bad response from Prometheus: ${err.message}`));
          }
        });
      })
      .on("error", reject)
      .on("timeout", function () {
        this.destroy(new Error("Prometheus query timed out"));
      });
  });
}

function firstValue(result) {
  if (!Array.isArray(result) || result.length === 0) return null;
  const v = result[0].value;
  if (!Array.isArray(v) || v.length < 2) return null;
  const num = parseFloat(v[1]);
  return Number.isFinite(num) ? num : null;
}

/**
 * Is `node` currently up according to node_exporter?
 * No data at all (never scraped, or the query itself errors) must NOT be
 * treated as "up" — but it must also not be treated as "idle" downstream
 * (see isIdle). This function only answers "is it currently reachable".
 */
async function isUp(node) {
  const result = await promQuery(`up{job="nodes",node="${node}"}`);
  const v = firstValue(result);
  return v === 1;
}

/**
 * True only if combined rx+tx traffic stayed below `thresholdBps` for the
 * ENTIRE timeout window — not just on average.
 *
 * Why max_over_time of a short-window rate, rather than one long rate():
 * rate(...)[120m] averages traffic across the whole two hours. A 5-minute
 * burst of real activity 90 minutes ago would be diluted across the full
 * window and could easily still read below threshold on average — a false
 * "idle" verdict despite recent real use. Taking the max of 2-minute rates
 * across the window instead means ANY 2-minute stretch of real traffic
 * anywhere in the window is caught, not smoothed away.
 */
async function trafficBps(node, timeoutMinutes) {
  const query =
    `max_over_time((` +
    `sum(rate(node_network_receive_bytes_total{node="${node}",device!="lo"}[2m])) + ` +
    `sum(rate(node_network_transmit_bytes_total{node="${node}",device!="lo"}[2m]))` +
    `)[${timeoutMinutes}m:2m])`;
  const result = await promQuery(query);
  return firstValue(result); // null if no data at all in the window
}

// ── Control API client ─────────────────────────────────────────────
function controlApiShutdown(node) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CONTROL_API_URL}/control/shutdown/${node}`);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: CONTROL_API_TOKEN ? { Authorization: `Bearer ${CONTROL_API_TOKEN}` } : {},
        timeout: 300000, // shutdown.sh drains k3s first; this can legitimately take a while
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.on("timeout", function () {
      this.destroy(new Error("Control API request timed out"));
    });
    req.end();
  });
}

// ── Evaluation loop ─────────────────────────────────────────────────
async function evaluateNode(node) {
  const cfg = nodeConfig(node);
  const entry = {
    thresholdBps: cfg.thresholdBps,
    timeoutMinutes: cfg.timeoutMinutes,
    up: null,
    trafficBps: null,
    idle: false,
    lastCheck: new Date().toISOString(),
    lastError: null,
  };

  try {
    entry.up = await isUp(node);
    if (!entry.up) {
      // Already off or unreachable: nothing to decide. This is the safe
      // no-op path, not a special case to work around.
      state[node] = entry;
      return;
    }

    const bps = await trafficBps(node, cfg.timeoutMinutes);
    entry.trafficBps = bps; // null means "no data for the full window yet" (e.g. just woke up)
    entry.idle = bps !== null && bps < cfg.thresholdBps;
    state[node] = entry;

    if (entry.idle) {
      const msg =
        `${node} idle for the full ${cfg.timeoutMinutes}m window ` +
        `(${bps.toFixed(0)} B/s < ${cfg.thresholdBps} B/s threshold)`;
      if (DRY_RUN) {
        console.log(`[DRY RUN] would shut down ${msg}`);
      } else {
        console.log(`Shutting down ${msg}`);
        const result = await controlApiShutdown(node);
        counters.actions_total[node] = (counters.actions_total[node] || 0) + 1;
        console.log(`Control API responded ${result.status}: ${result.body}`);
      }
    }
  } catch (err) {
    entry.lastError = err.message;
    counters.errors_total += 1;
    console.error(`Error evaluating ${node}: ${err.message}`);
    state[node] = entry;
  }
}

async function checkAll() {
  counters.checks_total += 1;
  for (const node of MANAGED_NODES) {
    await evaluateNode(node);
  }
}

// ── Metrics + status HTTP server ────────────────────────────────────
function renderMetrics() {
  const lines = [
    "# HELP homelab_idle_shutdown_checks_total Evaluation cycles run.",
    "# TYPE homelab_idle_shutdown_checks_total counter",
    `homelab_idle_shutdown_checks_total ${counters.checks_total}`,
    "# HELP homelab_idle_shutdown_errors_total Evaluation errors (Prometheus/Control API unreachable, etc).",
    "# TYPE homelab_idle_shutdown_errors_total counter",
    `homelab_idle_shutdown_errors_total ${counters.errors_total}`,
    "# HELP homelab_idle_shutdown_dry_run 1 if in dry-run (log only, never shuts anything down).",
    "# TYPE homelab_idle_shutdown_dry_run gauge",
    `homelab_idle_shutdown_dry_run ${DRY_RUN ? 1 : 0}`,
    "# HELP homelab_idle_shutdown_actions_total Real shutdown calls issued, by node.",
    "# TYPE homelab_idle_shutdown_actions_total counter",
  ];
  for (const [node, count] of Object.entries(counters.actions_total)) {
    lines.push(`homelab_idle_shutdown_actions_total{node="${node}"} ${count}`);
  }
  lines.push(
    "# HELP homelab_idle_shutdown_traffic_bps Combined rx+tx bytes/sec, peak across the node's timeout window.",
    "# TYPE homelab_idle_shutdown_traffic_bps gauge",
    "# HELP homelab_idle_shutdown_threshold_bps Configured idle threshold for the node.",
    "# TYPE homelab_idle_shutdown_threshold_bps gauge",
    "# HELP homelab_idle_shutdown_timeout_minutes Configured idle window for the node.",
    "# TYPE homelab_idle_shutdown_timeout_minutes gauge",
    "# HELP homelab_idle_shutdown_idle 1 if the node is currently considered idle (would shut down if not dry-run).",
    "# TYPE homelab_idle_shutdown_idle gauge",
    "# HELP homelab_idle_shutdown_node_up 1 if the node was reachable at the last check.",
    "# TYPE homelab_idle_shutdown_node_up gauge"
  );
  for (const [node, s] of Object.entries(state)) {
    if (s.trafficBps !== null) lines.push(`homelab_idle_shutdown_traffic_bps{node="${node}"} ${s.trafficBps}`);
    lines.push(`homelab_idle_shutdown_threshold_bps{node="${node}"} ${s.thresholdBps}`);
    lines.push(`homelab_idle_shutdown_timeout_minutes{node="${node}"} ${s.timeoutMinutes}`);
    lines.push(`homelab_idle_shutdown_idle{node="${node}"} ${s.idle ? 1 : 0}`);
    if (s.up !== null) lines.push(`homelab_idle_shutdown_node_up{node="${node}"} ${s.up ? 1 : 0}`);
  }
  return lines.join("\n") + "\n";
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    const body = JSON.stringify({
      status: "ok",
      dry_run: DRY_RUN,
      managed_nodes: MANAGED_NODES,
      check_interval_seconds: CHECK_INTERVAL_SECONDS,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(body);
  }
  if (req.method === "GET" && url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ dry_run: DRY_RUN, nodes: state }, null, 2));
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    return res.end(renderMetrics());
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// ── Startup ─────────────────────────────────────────────────────────
if (MANAGED_NODES.length === 0) {
  console.warn(
    "IDLE_SHUTDOWN_NODES is empty — this daemon will run but manage no nodes. " +
      "Set it to a comma-separated list, e.g. 'aery,sram,xelor'."
  );
}

console.log(`HomeLab Idle Shutdown daemon starting.`);
console.log(`  Managed nodes:   ${MANAGED_NODES.join(", ") || "(none)"}`);
console.log(`  Check interval:  ${CHECK_INTERVAL_SECONDS}s`);
console.log(`  Dry run:         ${DRY_RUN} ${DRY_RUN ? "(nothing will actually be shut down)" : "*** LIVE — will power off idle nodes ***"}`);
for (const node of MANAGED_NODES) {
  const cfg = nodeConfig(node);
  console.log(`  ${node}: timeout=${cfg.timeoutMinutes}m threshold=${cfg.thresholdBps}B/s`);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP status/metrics on :${PORT} (/health, /status, /metrics)`);
});

checkAll();
const timer = setInterval(checkAll, CHECK_INTERVAL_SECONDS * 1000);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`Received ${sig}, shutting down.`);
    clearInterval(timer);
    server.close(() => process.exit(0));
  });
}
