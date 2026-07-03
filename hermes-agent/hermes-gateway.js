#!/usr/bin/env node
/**
 * Hermes HTTP Gateway
 * Envuelve el MCP server en un servidor HTTP para que n8n
 * pueda llamarlo con el nodo HTTP Request sin necesidad de
 * un protocolo MCP nativo.
 *
 * POST /tool/:name   — ejecuta una tool con body JSON como args
 * GET  /health       — health check
 * GET  /tools        — lista tools disponibles
 */

import { createServer } from "http";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execFileAsync = promisify(execFile);

const PORT           = parseInt(process.env.PORT || "8080");
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || "/workspace";
const OUTPUT_DIR     = path.join(WORKSPACE_ROOT, "output");
const OLLAMA_URL     = process.env.OLLAMA_URL || "http://ollama-svc:11434";
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MAX_OUTPUT_LEN = 8000;

const SHELL_ALLOWLIST = [
  "ls", "find", "cat", "head", "tail", "grep", "wc",
  "pwd", "echo", "date", "df", "du", "stat",
  "python3", "node", "jq", "curl", "git",
];

await fs.mkdir(OUTPUT_DIR, { recursive: true });

// ── Tool implementations ──────────────────────────────────────────────────────

function assertInWorkspace(p) {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(path.resolve(WORKSPACE_ROOT))) {
    throw new Error(`Acceso denegado: '${p}' está fuera del workspace`);
  }
  return resolved;
}

function truncate(text, max = MAX_OUTPUT_LEN) {
  if (!text || text.length <= max) return text || "";
  return text.slice(0, max) + `\n… [truncado, ${text.length - max} chars más]`;
}

const TOOLS = {
  fs_list: async ({ dir }) => {
    const safe    = assertInWorkspace(dir || WORKSPACE_ROOT);
    const entries = await fs.readdir(safe, { withFileTypes: true });
    const lines   = entries.map(e =>
      `${e.isDirectory() ? "DIR " : "FILE"}  ${e.name}`
    );
    return `Contenido de ${safe}:\n${lines.join("\n") || "(vacío)"}`;
  },

  fs_read: async ({ path: p, max_bytes }) => {
    const safe      = assertInWorkspace(p);
    const maxBytes  = max_bytes || 32768;
    const handle    = await fs.open(safe, "r");
    const buf       = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    await handle.close();
    const content = buf.slice(0, bytesRead).toString("utf8");
    const suffix  = bytesRead === maxBytes ? "\n… [truncado]" : "";
    return content + suffix;
  },

  fs_write: async ({ filename, content, append }) => {
    const name    = path.basename(filename);
    const outPath = path.join(OUTPUT_DIR, name);
    await fs.writeFile(outPath, content, { flag: append ? "a" : "w", encoding: "utf8" });
    return `Escrito: ${outPath}`;
  },

  shell_exec: async ({ command, timeout }) => {
    const parts  = (command || "").trim().split(/\s+/);
    const binary = parts[0];
    const args   = parts.slice(1);
    if (!SHELL_ALLOWLIST.includes(binary)) {
      throw new Error(`Comando '${binary}' no permitido. Allowlist: ${SHELL_ALLOWLIST.join(", ")}`);
    }
    const { stdout, stderr } = await execFileAsync(binary, args, {
      cwd: WORKSPACE_ROOT,
      timeout: timeout || 10000,
      maxBuffer: 1024 * 512,
      env: { ...process.env, HOME: WORKSPACE_ROOT },
    });
    return truncate((stdout || "") + (stderr ? `\nSTDERR:\n${stderr}` : ""));
  },

  ollama_chat: async ({ prompt, model, system, temperature }) => {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || "qwen3.5:4b",
        stream: false,
        messages,
        options: { temperature: temperature ?? 0.7 },
      }),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return truncate(data.message?.content || "(sin respuesta)");
  },

  claude_chat: async ({ prompt, system, max_tokens }) => {
    if (!CLAUDE_API_KEY) throw new Error("ANTHROPIC_API_KEY no configurado");
    const body = {
      model:      "claude-sonnet-4-6",
      max_tokens: max_tokens || 1024,
      messages:   [{ role: "user", content: prompt }],
    };
    if (system) body.system = system;
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Claude ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return truncate(data.content?.[0]?.text || "(sin respuesta)");
  },
};

// ── HTTP server ───────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error("JSON inválido en el body")); }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":  "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

const srv = createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;

  // GET /health
  if (method === "GET" && url.pathname === "/health") {
    return send(res, 200, { status: "ok", workspace: WORKSPACE_ROOT, ollama: OLLAMA_URL });
  }

  // GET /tools
  if (method === "GET" && url.pathname === "/tools") {
    return send(res, 200, { tools: Object.keys(TOOLS) });
  }

  // POST /tool/:name
  if (method === "POST" && url.pathname.startsWith("/tool/")) {
    const toolName = url.pathname.replace("/tool/", "").split("/")[0];
    const handler  = TOOLS[toolName];
    if (!handler) {
      return send(res, 404, { error: `Tool '${toolName}' no existe`, available: Object.keys(TOOLS) });
    }
    try {
      const args   = await parseBody(req);
      const result = await handler(args);
      return send(res, 200, { ok: true, tool: toolName, result });
    } catch (err) {
      return send(res, 500, { ok: false, tool: toolName, error: err.message });
    }
  }

  send(res, 404, { error: "Ruta no encontrada" });
});

srv.listen(PORT, "0.0.0.0", () => {
  console.log(`Hermes HTTP gateway escuchando en :${PORT}`);
  console.log(`Workspace: ${WORKSPACE_ROOT}`);
  console.log(`Ollama:    ${OLLAMA_URL}`);
});
