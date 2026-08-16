#!/usr/bin/env node
/**
 * HomeLab Wake Proxy
 *
 * A reverse proxy for a single sleeping-capable node's HTTP service (today:
 * Aery's Nextcloud). Point your clients at THIS service instead of the node
 * directly. On every request:
 *
 *   1. Check (via a raw TCP connect, not Prometheus) whether the real
 *      backend is actually reachable right now.
 *   2. If yes: proxy the request through transparently, streaming both
 *      directions so large uploads/downloads don't get buffered in memory.
 *   3. If no: fire a wake request at the Control API (rate-limited — see
 *      WAKE_COOLDOWN_MS) and immediately serve a small "waking up" page
 *      that auto-refreshes. No request is ever held open for the full
 *      wake duration; each refresh is a fresh, fast request.
 *
 * Why this has to run somewhere else (Ocra), not on the node itself: when
 * the node is fully powered off, nothing running ON it can intercept
 * anything. The entry point necessarily moves to an always-on host.
 *
 * Why the outbound Host header is rewritten to the backend's own
 * hostname:port (TARGET_HOST:TARGET_PORT), not left as whatever the client
 * sent: Nextcloud (like most self-hosted apps) checks the Host header
 * against a `trusted_domains` allowlist in its own config. Rewriting it to
 * the hostname Nextcloud already trusts (the one it's always been accessed
 * as) means no Nextcloud-side config change is needed just to sit this
 * proxy in front of it.
 */

"use strict";

const http = require("http");
const net = require("net");

// ── Configuration ───────────────────────────────────────────────────
const TARGET_HOST = process.env.WAKE_PROXY_TARGET_HOST || "";
const TARGET_PORT = parseInt(process.env.WAKE_PROXY_TARGET_PORT || "8080", 10);
const NODE_NAME = process.env.WAKE_PROXY_NODE || "aery";
const LISTEN_PORT = parseInt(process.env.WAKE_PROXY_PORT || "8093", 10);
const ADMIN_PORT = parseInt(process.env.WAKE_PROXY_ADMIN_PORT || "8094", 10);
const CONTROL_API_URL = process.env.CONTROL_API_URL || "http://localhost:8090";
const CONTROL_API_TOKEN = process.env.CONTROL_API_TOKEN || "";
const CONNECT_TIMEOUT_MS = parseInt(process.env.WAKE_PROXY_CONNECT_TIMEOUT_MS || "1500", 10);
// Do not re-fire the wake call on every single holding-page refresh — WOL is
// idempotent, but there's no reason to hammer the Control API every 5s.
const WAKE_COOLDOWN_MS = parseInt(process.env.WAKE_PROXY_WAKE_COOLDOWN_MS || "30000", 10);
const REFRESH_SECONDS = parseInt(process.env.WAKE_PROXY_REFRESH_SECONDS || "5", 10);

if (!TARGET_HOST) {
  console.error("WAKE_PROXY_TARGET_HOST is required (e.g. 100.98.226.8 — a raw Tailscale IP, not a MagicDNS hostname)");
  process.exit(1);
}

// ── State (for /status and to drive the cooldown) ─────────────────────
let lastWakeCallAt = 0;
let wakeInFlight = false;
const counters = { requests_total: 0, proxied_total: 0, holding_page_total: 0, wake_calls_total: 0, wake_errors_total: 0 };
let lastUpCheck = null; // { up: bool, at: ISO string }

// ── Reachability check ─────────────────────────────────────────────
function checkTargetUp() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: TARGET_HOST, port: TARGET_PORT });
    let settled = false;
    const finish = (up) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      lastUpCheck = { up, at: new Date().toISOString() };
      resolve(up);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

// ── Control API client ─────────────────────────────────────────────
function triggerWake() {
  const now = Date.now();
  if (wakeInFlight || now - lastWakeCallAt < WAKE_COOLDOWN_MS) return;
  wakeInFlight = true;
  lastWakeCallAt = now;
  counters.wake_calls_total += 1;

  const url = new URL(`${CONTROL_API_URL}/control/wake/${NODE_NAME}`);
  const req = http.request(
    url,
    {
      method: "POST",
      headers: CONTROL_API_TOKEN ? { Authorization: `Bearer ${CONTROL_API_TOKEN}` } : {},
      timeout: 180000, // wake.sh itself waits up to 120s, plus k3s-ready polling
    },
    (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        console.log(`wake ${NODE_NAME}: ${res.statusCode} ${body}`);
        wakeInFlight = false;
      });
    }
  );
  req.on("error", (err) => {
    console.error(`wake ${NODE_NAME} failed: ${err.message}`);
    counters.wake_errors_total += 1;
    wakeInFlight = false;
  });
  req.on("timeout", function () {
    this.destroy(new Error("wake request timed out"));
  });
  req.end();
}

// ── Holding page ────────────────────────────────────────────────────
function holdingPage() {
  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<title>Despertando ${NODE_NAME}...</title>
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<style>
  body { font-family: system-ui, sans-serif; text-align: center; padding-top: 15vh;
         background: #0f172a; color: #e2e8f0; }
  .spinner { border: 6px solid #334155; border-top: 6px solid #38bdf8; border-radius: 50%;
             width: 48px; height: 48px; animation: spin 1s linear infinite; margin: 24px auto; }
  @keyframes spin { to { transform: rotate(360deg); } }
  p { color: #94a3b8; }
</style>
</head>
<body>
  <div class="spinner"></div>
  <h2>Despertando ${NODE_NAME}...</h2>
  <p>Esta página se actualiza sola cada ${REFRESH_SECONDS}s. Puede tardar hasta 60-90 segundos.</p>
</body></html>`;
  return html;
}

// ── HTTP proxy ──────────────────────────────────────────────────────
const proxyServer = http.createServer(async (req, res) => {
  counters.requests_total += 1;

  const up = await checkTargetUp();
  if (!up) {
    triggerWake();
    counters.holding_page_total += 1;
    const page = holdingPage();
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(page),
      "Cache-Control": "no-store",
    });
    return res.end(page);
  }

  counters.proxied_total += 1;
  const headers = Object.assign({}, req.headers, { host: `${TARGET_HOST}:${TARGET_PORT}` });
  const proxyReq = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    }
  );
  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end(`Bad gateway: ${err.message}`);
  });
  req.pipe(proxyReq, { end: true });
});

// WebSocket / upgrade passthrough (e.g. Nextcloud notify_push). Only
// attempted once the backend is already known-up from a recent request —
// if the very first thing a client does is an upgrade request while the
// node is asleep, it will simply fail to connect, same as any other client
// hitting a dead backend directly. In practice an upgrade always follows a
// successful page load, by which point the node is already awake.
proxyServer.on("upgrade", (req, clientSocket, head) => {
  const headers = Object.assign({}, req.headers, { host: `${TARGET_HOST}:${TARGET_PORT}` });
  const targetSocket = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    targetSocket.write(`${req.method} ${req.url} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
    if (head && head.length) targetSocket.write(head);
    targetSocket.pipe(clientSocket);
    clientSocket.pipe(targetSocket);
  });
  targetSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => targetSocket.destroy());
});

// ── Admin server: /health, /status, /metrics ────────────────────────
const adminServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "ok",
        node: NODE_NAME,
        target: `${TARGET_HOST}:${TARGET_PORT}`,
        listen_port: LISTEN_PORT,
      })
    );
  }
  if (req.method === "GET" && url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ last_up_check: lastUpCheck, wake_in_flight: wakeInFlight, counters }, null, 2));
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    const up = lastUpCheck ? (lastUpCheck.up ? 1 : 0) : "";
    const lines = [
      "# HELP homelab_wake_proxy_requests_total Requests received by the proxy.",
      "# TYPE homelab_wake_proxy_requests_total counter",
      `homelab_wake_proxy_requests_total{node="${NODE_NAME}"} ${counters.requests_total}`,
      "# HELP homelab_wake_proxy_proxied_total Requests actually proxied through to the backend.",
      "# TYPE homelab_wake_proxy_proxied_total counter",
      `homelab_wake_proxy_proxied_total{node="${NODE_NAME}"} ${counters.proxied_total}`,
      "# HELP homelab_wake_proxy_holding_page_total Requests answered with the holding page instead.",
      "# TYPE homelab_wake_proxy_holding_page_total counter",
      `homelab_wake_proxy_holding_page_total{node="${NODE_NAME}"} ${counters.holding_page_total}`,
      "# HELP homelab_wake_proxy_wake_calls_total Wake calls issued to the Control API.",
      "# TYPE homelab_wake_proxy_wake_calls_total counter",
      `homelab_wake_proxy_wake_calls_total{node="${NODE_NAME}"} ${counters.wake_calls_total}`,
      "# HELP homelab_wake_proxy_wake_errors_total Wake calls that errored.",
      "# TYPE homelab_wake_proxy_wake_errors_total counter",
      `homelab_wake_proxy_wake_errors_total{node="${NODE_NAME}"} ${counters.wake_errors_total}`,
    ];
    if (up !== "") {
      lines.push(
        "# HELP homelab_wake_proxy_target_up 1 if the last reachability check found the backend up.",
        "# TYPE homelab_wake_proxy_target_up gauge",
        `homelab_wake_proxy_target_up{node="${NODE_NAME}"} ${up}`
      );
    }
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    return res.end(lines.join("\n") + "\n");
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// ── Startup ─────────────────────────────────────────────────────────
console.log(`HomeLab Wake Proxy starting for node '${NODE_NAME}'`);
console.log(`  Public entry: :${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
console.log(`  Admin:        :${ADMIN_PORT} (/health, /status, /metrics)`);
console.log(`  Wake cooldown: ${WAKE_COOLDOWN_MS}ms`);

proxyServer.listen(LISTEN_PORT, "0.0.0.0");
adminServer.listen(ADMIN_PORT, "0.0.0.0");

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`Received ${sig}, shutting down.`);
    proxyServer.close();
    adminServer.close(() => process.exit(0));
  });
}
