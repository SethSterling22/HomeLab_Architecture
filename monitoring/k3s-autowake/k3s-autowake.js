#!/usr/bin/env node
/**
 * HomeLab k3s Auto-Wake Daemon
 *
 * Wakes a sleeping on-demand k3s worker (Sram, Xelor, Sacro) when the
 * cluster actually needs the capacity — i.e. there are Pending pods that
 * the scheduler has marked Unschedulable — rather than requiring a human
 * to notice and run `wake.sh` manually.
 *
 * There is no single HTTP entry point to intercept here (unlike Aery's
 * Nextcloud, see monitoring/wake-proxy/), so the "demand" signal has to
 * come from the Kubernetes API itself:
 *
 *   1. Poll for Pending pods whose PodScheduled condition is False with
 *      reason Unschedulable (the scheduler tried and could not fit them
 *      anywhere in the CURRENT capacity).
 *   2. If any exist, and at least one managed node is not Ready (i.e.
 *      asleep or still booting), wake exactly one of them.
 *   3. Rate-limited per node so a still-booting node doesn't get repeated
 *      wake calls every poll interval while it finishes joining the
 *      cluster.
 *
 * This is deliberately simple — it does not try to compute whether a
 * specific pending pod's resource requests would actually fit on a
 * specific sleeping node. For a homelab with 2-3 on-demand workers, "wake
 * one when something doesn't fit" is good enough; a real bin-packing
 * decision is not worth the complexity here.
 */

"use strict";

const http = require("http");
const { execFile } = require("child_process");

// ── Configuration ───────────────────────────────────────────────────
const KUBECONFIG = process.env.KUBECONFIG || "/home/autowake/.kube/config";
const KUBECTL_BIN = process.env.KUBECTL_BIN || "/usr/local/bin/kubectl";
const MANAGED_NODES = String(process.env.K3S_AUTOWAKE_NODES || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const CHECK_INTERVAL_SECONDS = parseInt(process.env.K3S_AUTOWAKE_CHECK_INTERVAL_SECONDS || "30", 10);
const WAKE_COOLDOWN_MS = parseInt(process.env.K3S_AUTOWAKE_WAKE_COOLDOWN_MS || "180000", 10); // 3 min: longer than a typical join time
const ADMIN_PORT = parseInt(process.env.K3S_AUTOWAKE_PORT || "8095", 10);
const CONTROL_API_URL = process.env.CONTROL_API_URL || "http://localhost:8090";
const CONTROL_API_TOKEN = process.env.CONTROL_API_TOKEN || "";

// ── State ───────────────────────────────────────────────────────────
const lastWakeCallAt = {}; // node -> timestamp
const counters = { checks_total: 0, wake_calls_total: {}, errors_total: 0 };
let lastPendingCount = 0;
let lastAsleepNodes = [];

// ── kubectl helpers (argv arrays only — same discipline as control-api) ──
function kubectl(args) {
  return new Promise((resolve, reject) => {
    execFile(
      KUBECTL_BIN,
      ["--kubeconfig", KUBECONFIG, ...args],
      { maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        resolve(stdout);
      }
    );
  });
}

async function getUnschedulablePendingCount() {
  const raw = await kubectl(["get", "pods", "-A", "-o", "json"]);
  const data = JSON.parse(raw);
  return data.items.filter((pod) => {
    if (pod.status?.phase !== "Pending") return false;
    const cond = (pod.status.conditions || []).find((c) => c.type === "PodScheduled");
    return cond && cond.status === "False" && cond.reason === "Unschedulable";
  }).length;
}

async function getManagedNodeReadiness() {
  const raw = await kubectl(["get", "nodes", "-o", "json"]);
  const data = JSON.parse(raw);
  const ready = {};
  for (const n of data.items) {
    const name = n.metadata.name;
    if (!MANAGED_NODES.includes(name)) continue;
    const cond = (n.status.conditions || []).find((c) => c.type === "Ready");
    ready[name] = Boolean(cond && cond.status === "True");
  }
  // Nodes that have never joined the cluster at all won't appear here —
  // treat "not present" the same as "not ready" (still asleep, never woken).
  for (const name of MANAGED_NODES) {
    if (!(name in ready)) ready[name] = false;
  }
  return ready;
}

// ── Control API client ─────────────────────────────────────────────
function wakeNode(node) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CONTROL_API_URL}/control/wake/${node}`);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: CONTROL_API_TOKEN ? { Authorization: `Bearer ${CONTROL_API_TOKEN}` } : {},
        timeout: 180000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.on("timeout", function () {
      this.destroy(new Error("wake request timed out"));
    });
    req.end();
  });
}

// ── Main loop ───────────────────────────────────────────────────────
async function checkAndWake() {
  counters.checks_total += 1;
  try {
    const pendingCount = await getUnschedulablePendingCount();
    lastPendingCount = pendingCount;

    if (pendingCount === 0) {
      lastAsleepNodes = [];
      return; // nothing needs capacity right now
    }

    const readiness = await getManagedNodeReadiness();
    const asleep = MANAGED_NODES.filter((n) => !readiness[n]);
    lastAsleepNodes = asleep;

    if (asleep.length === 0) {
      // Pods are unschedulable for some other reason (taints, affinity,
      // resource limits even with everyone awake) — not something waking
      // a node can fix, so this daemon has nothing useful to do.
      return;
    }

    const target = asleep.find((n) => Date.now() - (lastWakeCallAt[n] || 0) >= WAKE_COOLDOWN_MS);
    if (!target) return; // every asleep node was already woken recently; give it time to join

    console.log(`${pendingCount} unschedulable pod(s) pending, waking ${target}`);
    lastWakeCallAt[target] = Date.now();
    counters.wake_calls_total[target] = (counters.wake_calls_total[target] || 0) + 1;
    const result = await wakeNode(target);
    console.log(`Control API responded ${result.status}: ${result.body}`);
  } catch (err) {
    counters.errors_total += 1;
    console.error(`checkAndWake error: ${err.message}`);
  }
}

// ── Admin server: /health, /status, /metrics ────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", managed_nodes: MANAGED_NODES }));
  }
  if (req.method === "GET" && url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify(
        { managed_nodes: MANAGED_NODES, last_pending_count: lastPendingCount, last_asleep_nodes: lastAsleepNodes, counters },
        null,
        2
      )
    );
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    const lines = [
      "# HELP homelab_k3s_autowake_checks_total Evaluation cycles run.",
      "# TYPE homelab_k3s_autowake_checks_total counter",
      `homelab_k3s_autowake_checks_total ${counters.checks_total}`,
      "# HELP homelab_k3s_autowake_errors_total Evaluation errors (kubectl/Control API unreachable, etc).",
      "# TYPE homelab_k3s_autowake_errors_total counter",
      `homelab_k3s_autowake_errors_total ${counters.errors_total}`,
      "# HELP homelab_k3s_autowake_pending_unschedulable Unschedulable Pending pods seen at the last check.",
      "# TYPE homelab_k3s_autowake_pending_unschedulable gauge",
      `homelab_k3s_autowake_pending_unschedulable ${lastPendingCount}`,
      "# HELP homelab_k3s_autowake_wake_calls_total Wake calls issued, by node.",
      "# TYPE homelab_k3s_autowake_wake_calls_total counter",
    ];
    for (const [node, count] of Object.entries(counters.wake_calls_total)) {
      lines.push(`homelab_k3s_autowake_wake_calls_total{node="${node}"} ${count}`);
    }
    lines.push(
      "# HELP homelab_k3s_autowake_node_asleep 1 if a managed node was not Ready at the last check.",
      "# TYPE homelab_k3s_autowake_node_asleep gauge"
    );
    for (const node of MANAGED_NODES) {
      lines.push(`homelab_k3s_autowake_node_asleep{node="${node}"} ${lastAsleepNodes.includes(node) ? 1 : 0}`);
    }
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    return res.end(lines.join("\n") + "\n");
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// ── Startup ─────────────────────────────────────────────────────────
if (MANAGED_NODES.length === 0) {
  console.warn("K3S_AUTOWAKE_NODES is empty — this daemon will run but manage no nodes.");
}
console.log(`HomeLab k3s Auto-Wake daemon starting.`);
console.log(`  Managed nodes:  ${MANAGED_NODES.join(", ") || "(none)"}`);
console.log(`  Check interval: ${CHECK_INTERVAL_SECONDS}s`);
console.log(`  Wake cooldown:  ${WAKE_COOLDOWN_MS}ms per node`);

server.listen(ADMIN_PORT, "0.0.0.0", () => {
  console.log(`HTTP status/metrics on :${ADMIN_PORT} (/health, /status, /metrics)`);
});

checkAndWake();
const timer = setInterval(checkAndWake, CHECK_INTERVAL_SECONDS * 1000);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`Received ${sig}, shutting down.`);
    clearInterval(timer);
    server.close(() => process.exit(0));
  });
}
