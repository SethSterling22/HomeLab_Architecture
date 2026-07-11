#!/usr/bin/env node
/**
 * Hermes HTTP Gateway
 * Wraps the MCP server in an HTTP server so n8n can call it
 * with the HTTP Request node, without needing a native MCP protocol.
 *
 * POST /tool/:name   — run a tool with the JSON body as its args
 * GET  /health       — health check (also reports the active capabilities)
 * GET  /tools        — list available tools
 *
 * ── Capability toggles ────────────────────────────────────────────────────────
 * Everything is LOCKED DOWN by default. Widen permissions per need by setting
 * these env vars to a truthy value ("true"/"1"/"yes"/"on"):
 *
 *   HERMES_ALLOW_SSH                add ssh/scp/sftp/rsync/ssh-keyscan to the shell allowlist
 *   HERMES_SHELL_EXTRA             comma-separated extra binaries to allow (e.g. "rm,mv,cp,tar")
 *   HERMES_ALLOW_UNRESTRICTED_SHELL  run ANY command via `bash -lc` (no allowlist, full shell)
 *   HERMES_FS_UNRESTRICTED         read/list/write/delete anywhere on the filesystem
 *   HERMES_FS_ALLOW_WRITE_ANYWHERE fs_write may target any path (not just /workspace/output)
 *   HERMES_FS_ALLOW_DELETE         enable the fs_delete tool
 *   HERMES_DISABLE_CLAUDE_FALLBACK do NOT fall back to Ollama when Claude is unavailable
 *   HERMES_CLAUDE_FALLBACK_MODEL   Ollama model used as the Claude fallback (default: qwen3.5:4b)
 *
 * ── Second brain (git-backed Obsidian vault) ──────────────────────────────────
 * The note_save tool writes Markdown notes into a git repository (the "brain")
 * and, when sync is on, commits + pushes them so the vault stays in sync across
 * devices (GitHub). Configure it with:
 *
 *   HERMES_BRAIN_ROOT        path of the cloned brain repo (default: /workspace/brain)
 *   HERMES_BRAIN_GIT_SYNC    commit + push after each note (default: true)
 *   HERMES_BRAIN_GIT_REMOTE  git remote name to push to (default: origin)
 *   HERMES_BRAIN_GIT_BRANCH  branch to push (default: main)
 *   HERMES_BRAIN_GIT_SSH_KEY path to a private deploy key for push over SSH (optional)
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
// Ollama runs locally on Sadida (host, not a pod). Reachable via its Tailscale
// MagicDNS name or local IP. Override with OLLAMA_URL.
const OLLAMA_URL     = process.env.OLLAMA_URL || "http://sadida.stegosaurus-panga.ts.net:11434";
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MAX_OUTPUT_LEN = 8000;

// ── Capability toggles ─────────────────────────────────────────────────────────
const bool = (v) => /^(1|true|yes|on)$/i.test((v || "").trim());

const ALLOW_SSH               = bool(process.env.HERMES_ALLOW_SSH);
const ALLOW_UNRESTRICTED_SHELL = bool(process.env.HERMES_ALLOW_UNRESTRICTED_SHELL);
const SHELL_EXTRA             = (process.env.HERMES_SHELL_EXTRA || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const FS_UNRESTRICTED         = bool(process.env.HERMES_FS_UNRESTRICTED);
const FS_ALLOW_WRITE_ANYWHERE = bool(process.env.HERMES_FS_ALLOW_WRITE_ANYWHERE) || FS_UNRESTRICTED;
const FS_ALLOW_DELETE         = bool(process.env.HERMES_FS_ALLOW_DELETE);
const DISABLE_CLAUDE_FALLBACK = bool(process.env.HERMES_DISABLE_CLAUDE_FALLBACK);
const CLAUDE_FALLBACK_MODEL   = process.env.HERMES_CLAUDE_FALLBACK_MODEL || "qwen3.5:4b";

// ── Second brain (git-backed vault) ──────────────────────────────────────────
const BRAIN_ROOT       = process.env.HERMES_BRAIN_ROOT || path.join(WORKSPACE_ROOT, "brain");
// Sync is ON by default; set HERMES_BRAIN_GIT_SYNC=false to only write locally.
const BRAIN_GIT_SYNC   = process.env.HERMES_BRAIN_GIT_SYNC === undefined
  ? true : bool(process.env.HERMES_BRAIN_GIT_SYNC);
const BRAIN_GIT_REMOTE = process.env.HERMES_BRAIN_GIT_REMOTE || "origin";
const BRAIN_GIT_BRANCH = process.env.HERMES_BRAIN_GIT_BRANCH || "main";
const BRAIN_GIT_SSH_KEY = process.env.HERMES_BRAIN_GIT_SSH_KEY || "";

const BASE_ALLOWLIST = [
  "ls", "find", "cat", "head", "tail", "grep", "wc",
  "pwd", "echo", "date", "df", "du", "stat",
  "python3", "node", "jq", "curl", "git",
];
const SSH_COMMANDS = ["ssh", "scp", "sftp", "rsync", "ssh-keyscan"];
const SHELL_ALLOWLIST = [...new Set([
  ...BASE_ALLOWLIST,
  ...(ALLOW_SSH ? SSH_COMMANDS : []),
  ...SHELL_EXTRA,
])];

await fs.mkdir(OUTPUT_DIR, { recursive: true });

// ── Helpers ─────────────────────────────────────────────────────────────────

// Resolve a path. When FS_UNRESTRICTED is off, refuse anything outside the workspace.
function resolveSafe(p) {
  const resolved = path.resolve(p);
  if (FS_UNRESTRICTED) return resolved;
  if (!resolved.startsWith(path.resolve(WORKSPACE_ROOT))) {
    throw new Error(`Access denied: '${p}' is outside the workspace (set HERMES_FS_UNRESTRICTED=true to allow)`);
  }
  return resolved;
}

function truncate(text, max = MAX_OUTPUT_LEN) {
  if (!text || text.length <= max) return text || "";
  return text.slice(0, max) + `\n… [truncated, ${text.length - max} more chars]`;
}

// Shared Ollama call — also used as the Claude fallback.
async function ollamaChat({ prompt, model, system, temperature }) {
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
  return truncate(data.message?.content || "(no response)");
}

// Turn an arbitrary title into a filesystem-safe slug for the note filename.
function slugify(s) {
  return (s || "note")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "note";
}

// Run a git command inside the brain repo. Args are passed as an array, so
// commit messages with spaces/quotes are safe (no shell involved).
function brainGit(args) {
  const env = { ...process.env, HOME: WORKSPACE_ROOT };
  if (BRAIN_GIT_SSH_KEY) {
    env.GIT_SSH_COMMAND = `ssh -i ${BRAIN_GIT_SSH_KEY} -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes`;
  }
  return execFileAsync("git", [
    "-C", BRAIN_ROOT,
    "-c", "user.name=Cerebro",
    "-c", "user.email=cerebro@homelab.local",
    ...args,
  ], { timeout: 30000, maxBuffer: 1024 * 1024, env });
}

// ── Tool implementations ──────────────────────────────────────────────────────

const TOOLS = {
  fs_list: async ({ dir }) => {
    const safe    = resolveSafe(dir || WORKSPACE_ROOT);
    const entries = await fs.readdir(safe, { withFileTypes: true });
    const lines   = entries.map(e =>
      `${e.isDirectory() ? "DIR " : "FILE"}  ${e.name}`
    );
    return `Contents of ${safe}:\n${lines.join("\n") || "(empty)"}`;
  },

  fs_read: async ({ path: p, max_bytes }) => {
    const safe      = resolveSafe(p);
    const maxBytes  = max_bytes || 32768;
    const handle    = await fs.open(safe, "r");
    const buf       = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    await handle.close();
    const content = buf.slice(0, bytesRead).toString("utf8");
    const suffix  = bytesRead === maxBytes ? "\n… [truncated]" : "";
    return content + suffix;
  },

  fs_write: async ({ filename, path: p, content, append }) => {
    let outPath;
    const target = p || filename;
    // Write anywhere only when explicitly enabled AND a path (not a bare name) is given.
    if (FS_ALLOW_WRITE_ANYWHERE && target && target.includes("/")) {
      outPath = resolveSafe(target);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
    } else {
      outPath = path.join(OUTPUT_DIR, path.basename(target));
    }
    await fs.writeFile(outPath, content, { flag: append ? "a" : "w", encoding: "utf8" });
    return `Written: ${outPath}`;
  },

  fs_delete: async ({ path: p, recursive }) => {
    if (!FS_ALLOW_DELETE) {
      throw new Error("fs_delete is disabled (set HERMES_FS_ALLOW_DELETE=true to enable)");
    }
    const safe = resolveSafe(p);
    await fs.rm(safe, { recursive: !!recursive, force: false });
    return `Deleted: ${safe}`;
  },

  shell_exec: async ({ command, timeout }) => {
    const cmd = (command || "").trim();
    if (!cmd) throw new Error("Empty command");
    const opts = {
      cwd: WORKSPACE_ROOT,
      timeout: timeout || 10000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, HOME: WORKSPACE_ROOT },
    };

    // Unrestricted mode: run the whole command through a real shell (pipes, redirects, &&).
    if (ALLOW_UNRESTRICTED_SHELL) {
      const { stdout, stderr } = await execFileAsync("bash", ["-lc", cmd], opts);
      return truncate((stdout || "") + (stderr ? `\nSTDERR:\n${stderr}` : ""));
    }

    // Allowlist mode: only the first binary is checked; no shell metacharacters.
    const parts  = cmd.split(/\s+/);
    const binary = parts[0];
    if (!SHELL_ALLOWLIST.includes(binary)) {
      throw new Error(
        `Command '${binary}' not allowed. Allowlist: ${SHELL_ALLOWLIST.join(", ")} ` +
        `(widen with HERMES_ALLOW_SSH / HERMES_SHELL_EXTRA / HERMES_ALLOW_UNRESTRICTED_SHELL)`
      );
    }
    const { stdout, stderr } = await execFileAsync(binary, parts.slice(1), opts);
    return truncate((stdout || "") + (stderr ? `\nSTDERR:\n${stderr}` : ""));
  },

  // Save a Markdown note into the git-backed "second brain" and (optionally)
  // commit + push it so the Obsidian vault syncs across devices.
  note_save: async ({ title, content, folder, tags, sync }) => {
    const now      = new Date();
    const date     = now.toISOString().slice(0, 10);      // YYYY-MM-DD
    const stamp    = now.toISOString().replace(/[:.]/g, "-"); // unique-ish
    const noteTitle = (title || "Quick note").trim();
    const subdir   = (folder || "Inbox").replace(/[^A-Za-z0-9/_-]/g, "");
    const dir      = path.join(BRAIN_ROOT, subdir);
    const filename = `${date}-${slugify(noteTitle)}.md`;
    const outPath  = path.join(dir, filename);

    // Normalize tags to an array.
    const tagList = Array.isArray(tags)
      ? tags
      : (tags ? String(tags).split(",").map(t => t.trim()).filter(Boolean) : []);

    const frontmatter = [
      "---",
      `title: ${JSON.stringify(noteTitle)}`,
      `created: ${now.toISOString()}`,
      `tags: [${tagList.map(t => JSON.stringify(t)).join(", ")}]`,
      "source: cerebro",
      "---",
      "",
    ].join("\n");

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(outPath, frontmatter + (content || noteTitle) + "\n", "utf8");

    // Decide whether to sync: explicit arg wins, otherwise the env default.
    const doSync = sync === undefined ? BRAIN_GIT_SYNC : bool(String(sync));
    let synced = "local-only";
    if (doSync) {
      try {
        await brainGit(["add", "--", outPath]);
        await brainGit(["commit", "-m", `note: ${noteTitle}`]);
        await brainGit(["push", BRAIN_GIT_REMOTE, BRAIN_GIT_BRANCH]);
        synced = `pushed to ${BRAIN_GIT_REMOTE}/${BRAIN_GIT_BRANCH}`;
      } catch (err) {
        // The note is safely on disk even if the push fails.
        synced = `saved locally, git sync failed: ${err.message}`;
      }
    }
    return `Note saved: ${subdir}/${filename} (${synced})`;
  },

  ollama_chat: async (args) => ollamaChat(args),

  claude_chat: async ({ prompt, system, max_tokens, temperature }) => {
    // No key configured → transparently fall back to Ollama (Qwen), unless disabled.
    if (!CLAUDE_API_KEY) {
      if (DISABLE_CLAUDE_FALLBACK) throw new Error("ANTHROPIC_API_KEY not configured");
      console.log(`[claude_chat] no API key — falling back to ollama:${CLAUDE_FALLBACK_MODEL}`);
      return ollamaChat({ prompt, model: CLAUDE_FALLBACK_MODEL, system, temperature });
    }
    const body = {
      model:      "claude-sonnet-4-6",
      max_tokens: max_tokens || 1024,
      messages:   [{ role: "user", content: prompt }],
    };
    if (system) body.system = system;
    try {
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
      return truncate(data.content?.[0]?.text || "(no response)");
    } catch (err) {
      // API failed (quota, network, etc.) → fall back to Ollama unless disabled.
      if (DISABLE_CLAUDE_FALLBACK) throw err;
      console.log(`[claude_chat] Claude failed (${err.message}) — falling back to ollama:${CLAUDE_FALLBACK_MODEL}`);
      return ollamaChat({ prompt, model: CLAUDE_FALLBACK_MODEL, system, temperature });
    }
  },
};

// Tools advertised on GET /tools (hide fs_delete unless enabled).
function publicTools() {
  return Object.keys(TOOLS).filter(t => t !== "fs_delete" || FS_ALLOW_DELETE);
}

function capabilities() {
  return {
    ssh: ALLOW_SSH,
    unrestricted_shell: ALLOW_UNRESTRICTED_SHELL,
    fs_unrestricted: FS_UNRESTRICTED,
    fs_write_anywhere: FS_ALLOW_WRITE_ANYWHERE,
    fs_delete: FS_ALLOW_DELETE,
    shell_allowlist: ALLOW_UNRESTRICTED_SHELL ? "ANY" : SHELL_ALLOWLIST,
    claude_fallback: CLAUDE_API_KEY ? "claude" : (DISABLE_CLAUDE_FALLBACK ? "none" : `ollama:${CLAUDE_FALLBACK_MODEL}`),
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error("Invalid JSON in body")); }
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
    return send(res, 200, {
      status: "ok",
      workspace: WORKSPACE_ROOT,
      ollama: OLLAMA_URL,
      capabilities: capabilities(),
    });
  }

  // GET /tools
  if (method === "GET" && url.pathname === "/tools") {
    return send(res, 200, { tools: publicTools() });
  }

  // POST /tool/:name
  if (method === "POST" && url.pathname.startsWith("/tool/")) {
    const toolName = url.pathname.replace("/tool/", "").split("/")[0];
    const handler  = TOOLS[toolName];
    if (!handler) {
      return send(res, 404, { error: `Tool '${toolName}' does not exist`, available: publicTools() });
    }
    try {
      const args   = await parseBody(req);
      const result = await handler(args);
      return send(res, 200, { ok: true, tool: toolName, result });
    } catch (err) {
      return send(res, 500, { ok: false, tool: toolName, error: err.message });
    }
  }

  send(res, 404, { error: "Route not found" });
});

srv.listen(PORT, "0.0.0.0", () => {
  console.log(`Hermes HTTP gateway listening on :${PORT}`);
  console.log(`Workspace: ${WORKSPACE_ROOT}`);
  console.log(`Ollama:    ${OLLAMA_URL}`);
  console.log(`Capabilities:`, JSON.stringify(capabilities()));
});
