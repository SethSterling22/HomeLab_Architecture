#!/usr/bin/env node
/**
 * HomeLab Control API
 *
 * A deliberately small HTTP service that lets the Grafana dashboard power
 * nodes on and off. It is a thin, guarded wrapper around the Wake-on-LAN
 * helpers that already live in this repository (scripts/wol/*).
 *
 * Design constraints, in order of importance:
 *
 *   1. Never build a shell string. Every invocation uses execFile with an
 *      argv array, so a node name can never be interpreted as a command.
 *   2. Only names on a hardcoded allowlist reach the scripts at all. The
 *      allowlist is checked before anything is executed.
 *   3. Shutdown is opt-in per node. Nodes that would break the lab (or this
 *      very dashboard) if powered off are protected by default.
 *   4. Every request needs a bearer token. The service is expected to be
 *      reachable only over Tailscale on top of that.
 *
 * Endpoints:
 *   GET  /health                 - liveness + effective configuration
 *   GET  /metrics                - Prometheus metrics for this service
 *   GET  /nodes                  - allowlist and per-node permissions
 *   POST /control/wake/:node     - send a magic packet
 *   POST /control/shutdown/:node - drain from k3s and power off
 *   GET  /control/status         - output of scripts/wol/status.sh
 */

"use strict";

const http = require("http");
const path = require("path");
const { execFile } = require("child_process");

// ── Configuration ───────────────────────────────────────────────────
const PORT = parseInt(process.env.CONTROL_API_PORT || "8090", 10);
const HOST = process.env.CONTROL_API_HOST || "0.0.0.0";
const TOKEN = process.env.CONTROL_API_TOKEN || "";
const SCRIPTS_DIR = process.env.CONTROL_API_SCRIPTS_DIR || "/opt/homelab/scripts/wol";
// Scripts wait for a node to come up (wake) or go down (shutdown), so the
// timeout has to exceed the scripts' own internal waits.
const EXEC_TIMEOUT_MS = parseInt(process.env.CONTROL_API_TIMEOUT_MS || "300000", 10);

const bool = (v) => /^(1|true|yes|on)$/i.test(String(v || ""));

/**
 * Nodes this service is allowed to touch.
 *
 * `shutdown: false` is the safe default and is set for:
 *   - sadida: the k3s control-plane and the Ollama GPU host.
 *   - ocra:   runs Prometheus, Grafana and THIS service. Powering it off from
 *             its own dashboard would kill the dashboard mid-request.
 *   - aery:   24/7 Nextcloud and storage; other nodes mount from it.
 *
 * Override per node with env vars if you really mean it, e.g.
 *   CONTROL_API_ALLOW_SHUTDOWN_AERY=true
 */
const NODES = {
  sadida: { wake: false, shutdown: false, tier: "always_on", note: "k3s control-plane + GPU/Ollama host" },
  ocra: { wake: true, shutdown: false, tier: "always_on", note: "hosts this dashboard and the automation stack" },
  aery: { wake: true, shutdown: false, tier: "always_on", note: "Nextcloud + shared storage" },
  sram: { wake: true, shutdown: true, tier: "always_on", note: "k3s worker" },
  xelor: { wake: true, shutdown: true, tier: "on_demand", note: "k3s worker (staging)" },
  sacro: { wake: true, shutdown: true, tier: "on_demand", note: "k3s worker (observability)" },
};

// Apply per-node environment overrides (CONTROL_API_ALLOW_SHUTDOWN_<NODE>).
for (const name of Object.keys(NODES)) {
  const override = process.env[`CONTROL_API_ALLOW_SHUTDOWN_${name.toUpperCase()}`];
  if (override !== undefined) NODES[name].shutdown = bool(override);
}

// ── Metrics ─────────────────────────────────────────────────────────
const metrics = {
  requests: 0,
  wake_total: {},
  shutdown_total: {},
  errors_total: 0,
};

// ── Helpers ─────────────────────────────────────────────────────────
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function authorized(req) {
  // An empty token means auth is disabled. That is only sane on a trusted
  // network, so it is logged loudly at startup rather than silently allowed.
  if (!TOKEN) return true;
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-control-token"] || "";
  // Length check first so the comparison below never throws on mismatch.
  if (provided.length !== TOKEN.length) return false;
  // Constant-time comparison to avoid leaking the token via timing.
  const crypto = require("crypto");
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(TOKEN));
}

/**
 * Run one of the WOL scripts.
 *
 * `args` is always an array — this is what makes node names inert. Even if a
 * caller smuggled `; rm -rf /` past the allowlist, it would arrive as a single
 * literal argv entry and the script would simply reject it as an unknown node.
 */
/**
 * Reads and parses a JSON request body. Used only by the generic POST
 * /control endpoint below — every other endpoint takes its arguments from
 * the URL, which needs no body parsing at all.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function runScript(script, args = []) {
  return new Promise((resolve) => {
    const file = path.join(SCRIPTS_DIR, script);
    execFile(
      file,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        // Strip ANSI colour codes: the scripts are written for a terminal,
        // but this output is rendered inside a Grafana panel.
        const clean = (s) => String(s || "").replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (error) {
          resolve({
            ok: false,
            code: error.code ?? null,
            timedOut: Boolean(error.killed),
            stdout: clean(stdout),
            stderr: clean(stderr) || clean(error.message),
          });
          return;
        }
        resolve({ ok: true, code: 0, stdout: clean(stdout), stderr: clean(stderr) });
      }
    );
  });
}

// ── Handlers ────────────────────────────────────────────────────────
async function handleWake(res, node) {
  const cfg = NODES[node];
  if (!cfg) return send(res, 404, { ok: false, error: `Unknown node '${node}'` });
  if (!cfg.wake) return send(res, 403, { ok: false, error: `Wake is not permitted for '${node}'` });

  const result = await runScript("wake.sh", [node]);
  metrics.wake_total[node] = (metrics.wake_total[node] || 0) + 1;
  if (!result.ok) metrics.errors_total += 1;

  return send(res, result.ok ? 200 : 500, {
    ok: result.ok,
    action: "wake",
    node,
    message: result.ok ? `Magic packet sent to ${node}` : `Failed to wake ${node}`,
    output: result.stdout,
    error: result.ok ? undefined : result.stderr,
  });
}

async function handleShutdown(res, node, skipDrain) {
  const cfg = NODES[node];
  if (!cfg) return send(res, 404, { ok: false, error: `Unknown node '${node}'` });
  if (!cfg.shutdown) {
    return send(res, 403, {
      ok: false,
      error: `Shutdown is blocked for '${node}': ${cfg.note}. ` +
        `Set CONTROL_API_ALLOW_SHUTDOWN_${node.toUpperCase()}=true to override.`,
    });
  }

  // --yes is mandatory here: the script prompts on a TTY and this caller has none.
  const args = [node, "--yes"];
  if (skipDrain) args.push("--skip-drain");

  const result = await runScript("shutdown.sh", args);
  metrics.shutdown_total[node] = (metrics.shutdown_total[node] || 0) + 1;
  if (!result.ok) metrics.errors_total += 1;

  return send(res, result.ok ? 200 : 500, {
    ok: result.ok,
    action: "shutdown",
    node,
    drained: !skipDrain,
    message: result.ok ? `${node} powered off` : `Failed to power off ${node}`,
    output: result.stdout,
    error: result.ok ? undefined : result.stderr,
  });
}

async function handleStatus(res) {
  const result = await runScript("status.sh", []);
  return send(res, result.ok ? 200 : 500, {
    ok: result.ok,
    action: "status",
    output: result.stdout,
    error: result.ok ? undefined : result.stderr,
  });
}

function renderMetrics() {
  const lines = [
    "# HELP homelab_control_requests_total Total requests handled by the Control API.",
    "# TYPE homelab_control_requests_total counter",
    `homelab_control_requests_total ${metrics.requests}`,
    "# HELP homelab_control_errors_total Failed control actions.",
    "# TYPE homelab_control_errors_total counter",
    `homelab_control_errors_total ${metrics.errors_total}`,
    "# HELP homelab_control_wake_total Wake actions issued, by node.",
    "# TYPE homelab_control_wake_total counter",
  ];
  for (const [node, count] of Object.entries(metrics.wake_total)) {
    lines.push(`homelab_control_wake_total{node="${node}"} ${count}`);
  }
  lines.push("# HELP homelab_control_shutdown_total Shutdown actions issued, by node.");
  lines.push("# TYPE homelab_control_shutdown_total counter");
  for (const [node, count] of Object.entries(metrics.shutdown_total)) {
    lines.push(`homelab_control_shutdown_total{node="${node}"} ${count}`);
  }
  return lines.join("\n") + "\n";
}

// ── Server ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  metrics.requests += 1;

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const segments = url.pathname.split("/").filter(Boolean);

  // Unauthenticated: liveness and scrape endpoints.
  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, {
      status: "ok",
      auth: TOKEN ? "token" : "disabled",
      scripts_dir: SCRIPTS_DIR,
      nodes: Object.keys(NODES),
    });
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    const body = renderMetrics();
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    return res.end(body);
  }

  if (!authorized(req)) {
    return send(res, 401, { ok: false, error: "Unauthorized: missing or invalid token" });
  }

  if (req.method === "GET" && url.pathname === "/nodes") {
    return send(res, 200, { ok: true, nodes: NODES });
  }

  if (req.method === "GET" && url.pathname === "/control/status") {
    return handleStatus(res);
  }

  // Generic body-based endpoint: POST /control with {"action": "wake"|"shutdown", "node": "..."}.
  // Exists specifically for callers that can't template a dynamic path
  // (e.g. the Grafana Business Forms panel's REST API mode only
  // interpolates dashboard variables into the URL, not per-request form
  // values — see monitoring/README.md, "Grafana buttons"). The path-based
  // routes below remain the primary interface for scripts/curl/wake-proxy/
  // k3s-autowake; this is purely additive.
  if (req.method === "POST" && url.pathname === "/control") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return send(res, 400, { ok: false, error: `Invalid JSON body: ${err.message}` });
    }
    const { action, node, skip_drain } = body || {};
    if (!node) return send(res, 400, { ok: false, error: "Missing 'node' in request body" });
    if (action === "wake") return handleWake(res, node);
    if (action === "shutdown") return handleShutdown(res, node, Boolean(skip_drain));
    return send(res, 400, { ok: false, error: `Unknown or missing 'action' (expected 'wake' or 'shutdown')` });
  }

  if (req.method === "POST" && segments[0] === "control") {
    const [, action, node] = segments;
    if (!node) return send(res, 400, { ok: false, error: "Missing node name" });

    if (action === "wake") return handleWake(res, node);
    if (action === "shutdown") {
      return handleShutdown(res, node, url.searchParams.get("skip_drain") === "true");
    }
    return send(res, 404, { ok: false, error: `Unknown action '${action}'` });
  }

  return send(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`HomeLab Control API listening on ${HOST}:${PORT}`);
  console.log(`Scripts:  ${SCRIPTS_DIR}`);
  console.log(`Auth:     ${TOKEN ? "bearer token required" : "DISABLED"}`);
  if (!TOKEN) {
    console.warn(
      "WARNING: CONTROL_API_TOKEN is empty. Anyone who can reach this port " +
        "can power nodes on and off. Set a token before exposing it."
    );
  }
  const shutdownable = Object.entries(NODES)
    .filter(([, c]) => c.shutdown)
    .map(([n]) => n);
  console.log(`Shutdown permitted for: ${shutdownable.join(", ") || "(none)"}`);
});

// Terminate cleanly so `docker compose restart` is fast.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`Received ${sig}, shutting down.`);
    server.close(() => process.exit(0));
  });
}
