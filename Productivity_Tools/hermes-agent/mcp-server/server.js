#!/usr/bin/env node
/**
 * Hermes MCP Server
 * Exposes filesystem, shell, and API tools to the agent.
 * Runs inside a sandbox with controlled bind mounts.
 *
 * Available tools:
 *   fs_list      — ls a directory
 *   fs_read      — read a file
 *   fs_write     — write a file
 *   fs_delete    — delete a file/dir (only when HERMES_FS_ALLOW_DELETE=true)
 *   shell_exec   — run a command (allowlist, or any command in unrestricted mode)
 *   note_save    — save a Markdown note into the git-backed "second brain" and push it
 *   ollama_chat  — call Ollama via API
 *   claude_chat  — call the Claude API (falls back to Ollama/Qwen when unavailable)
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
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execFileAsync = promisify(execFile);

// ── Configuration ─────────────────────────────────────────────────────────────
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || "/workspace";
const OUTPUT_DIR     = path.join(WORKSPACE_ROOT, "output");
// Ollama runs locally on Sadida (host, not a pod), reachable via Tailscale.
const OLLAMA_URL     = process.env.OLLAMA_URL     || "http://sadida.stegosaurus-panga.ts.net:11434";
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_URL     = "https://api.anthropic.com/v1/messages";
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
const BRAIN_GIT_SYNC   = process.env.HERMES_BRAIN_GIT_SYNC === undefined
  ? true : bool(process.env.HERMES_BRAIN_GIT_SYNC);
const BRAIN_GIT_REMOTE = process.env.HERMES_BRAIN_GIT_REMOTE || "origin";
const BRAIN_GIT_BRANCH = process.env.HERMES_BRAIN_GIT_BRANCH || "main";
const BRAIN_GIT_SSH_KEY = process.env.HERMES_BRAIN_GIT_SSH_KEY || "";

// Base commands allowed in shell_exec — SSH set and extras are added by toggles.
const BASE_ALLOWLIST = [
  "ls", "find", "cat", "head", "tail", "grep", "wc",
  "pwd", "echo", "date", "df", "du", "stat",
  "python3", "node", "jq", "curl",
  "git", "npm", "pip3",
];
const SSH_COMMANDS = ["ssh", "scp", "sftp", "rsync", "ssh-keyscan"];
const SHELL_ALLOWLIST = [...new Set([
  ...BASE_ALLOWLIST,
  ...(ALLOW_SSH ? SSH_COMMANDS : []),
  ...SHELL_EXTRA,
])];

// ── Helpers ───────────────────────────────────────────────────────────────────
function resolveSafe(filePath) {
  const resolved = path.resolve(filePath);
  if (FS_UNRESTRICTED) return resolved;
  if (!resolved.startsWith(path.resolve(WORKSPACE_ROOT))) {
    throw new Error(`Access denied: '${filePath}' is outside ${WORKSPACE_ROOT} (set HERMES_FS_UNRESTRICTED=true to allow)`);
  }
  return resolved;
}

function truncate(text, max = MAX_OUTPUT_LEN) {
  if (text.length <= max) return text;
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
  if (!resp.ok) throw new Error(`Ollama error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return truncate(data.message?.content || "(no response)");
}

// Turn an arbitrary title into a filesystem-safe slug for the note filename.
function slugify(s) {
  return (s || "note")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "note";
}

// Run a git command inside the brain repo (args as an array — spaces are safe).
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

// Shared note_save implementation (used by the CallTool handler).
async function saveNote({ title, content, folder, tags, sync }) {
  const now       = new Date();
  const date      = now.toISOString().slice(0, 10);
  const noteTitle = (title || "Quick note").trim();
  const subdir    = (folder || "Inbox").replace(/[^A-Za-z0-9/_-]/g, "");
  const dir       = path.join(BRAIN_ROOT, subdir);
  const filename  = `${date}-${slugify(noteTitle)}.md`;
  const outPath   = path.join(dir, filename);

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

  const doSync = sync === undefined ? BRAIN_GIT_SYNC : bool(String(sync));
  let synced = "local-only";
  if (doSync) {
    try {
      await brainGit(["add", "--", outPath]);
      await brainGit(["commit", "-m", `note: ${noteTitle}`]);
      await brainGit(["push", BRAIN_GIT_REMOTE, BRAIN_GIT_BRANCH]);
      synced = `pushed to ${BRAIN_GIT_REMOTE}/${BRAIN_GIT_BRANCH}`;
    } catch (err) {
      synced = `saved locally, git sync failed: ${err.message}`;
    }
  }
  return `Note saved: ${subdir}/${filename} (${synced})`;
}

// ── Initialize output dir ───────────────────────────────────────────────────
await fs.mkdir(OUTPUT_DIR, { recursive: true });

// ── Server ────────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "hermes-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Tool list ─────────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    {
      name: "fs_list",
      description: "List files and directories.",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Path to list. Default: /workspace" },
        },
      },
    },
    {
      name: "fs_read",
      description: "Read the contents of a file.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "File path" },
          max_bytes: { type: "number", description: "Maximum bytes to read (default 32768)" },
        },
      },
    },
    {
      name: "fs_write",
      description: FS_ALLOW_WRITE_ANYWHERE
        ? "Write a file. Provide a full path to write anywhere, or a bare filename to write under /workspace/output."
        : "Write a file under /workspace/output/. Writing is only allowed in this directory.",
      inputSchema: {
        type: "object",
        required: ["content"],
        properties: {
          filename: { type: "string", description: "File name (written under /workspace/output)" },
          path:     { type: "string", description: "Full path (only used when write-anywhere is enabled)" },
          content:  { type: "string", description: "Content to write" },
          append:   { type: "boolean", description: "If true, append to the end of the file" },
        },
      },
    },
    {
      name: "shell_exec",
      description: ALLOW_UNRESTRICTED_SHELL
        ? "Run ANY command through bash -lc (unrestricted mode is enabled)."
        : `Run a command. Allowlisted commands only: ${SHELL_ALLOWLIST.join(", ")}`,
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string", description: "Command to run (e.g. 'ls -la /workspace')" },
          timeout: { type: "number", description: "Timeout in ms (default 10000)" },
        },
      },
    },
    {
      name: "note_save",
      description: "Save a Markdown note into the git-backed second brain (Obsidian vault). Commits and pushes to GitHub when sync is enabled.",
      inputSchema: {
        type: "object",
        required: ["content"],
        properties: {
          title:   { type: "string", description: "Note title (used for the filename and frontmatter)" },
          content: { type: "string", description: "Markdown body of the note" },
          folder:  { type: "string", description: "Subfolder in the vault (default: Inbox)" },
          tags:    { type: "array", items: { type: "string" }, description: "Optional tags" },
          sync:    { type: "boolean", description: "Commit + push to git (default: HERMES_BRAIN_GIT_SYNC)" },
        },
      },
    },
    {
      name: "ollama_chat",
      description: "Send a prompt to Ollama (local LLM on Sadida). Use for private tasks, batch, or routing.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt:      { type: "string", description: "Message to the model" },
          model:       { type: "string", description: "Ollama model (default: qwen3.5:4b)" },
          system:      { type: "string", description: "Optional system prompt" },
          temperature: { type: "number", description: "Temperature (default: 0.7)" },
        },
      },
    },
    {
      name: "claude_chat",
      description: "Send a prompt to the Claude API. Falls back to Ollama/Qwen automatically when no API key is set or the API fails.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt:    { type: "string", description: "Message to the model" },
          system:    { type: "string", description: "Optional system prompt" },
          max_tokens: { type: "number", description: "Maximum tokens (default: 1024)" },
          temperature: { type: "number", description: "Temperature for the fallback model (default: 0.7)" },
        },
      },
    },
  ];

  // Expose the destructive delete tool only when explicitly enabled.
  if (FS_ALLOW_DELETE) {
    tools.push({
      name: "fs_delete",
      description: "Delete a file or directory.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path:      { type: "string", description: "Path to delete" },
          recursive: { type: "boolean", description: "Delete directories recursively" },
        },
      },
    });
  }

  return { tools };
});

// ── Tool handlers ─────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // ── fs_list ──────────────────────────────────────────────────────────────
    if (name === "fs_list") {
      const dir = args.dir || WORKSPACE_ROOT;
      const safe = resolveSafe(dir);
      const entries = await fs.readdir(safe, { withFileTypes: true });
      const lines = entries.map((e) => {
        const type = e.isDirectory() ? "DIR " : e.isFile() ? "FILE" : "    ";
        return `${type}  ${e.name}`;
      });
      return {
        content: [{ type: "text", text: `Contents of ${safe}:\n${lines.join("\n") || "(empty)"}` }],
      };
    }

    // ── fs_read ──────────────────────────────────────────────────────────────
    if (name === "fs_read") {
      const safe = resolveSafe(args.path);
      const maxBytes = args.max_bytes || 32768;
      const handle = await fs.open(safe, "r");
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
      await handle.close();
      const content = buf.slice(0, bytesRead).toString("utf8");
      const suffix = bytesRead === maxBytes ? `\n… [truncated, read more with a larger max_bytes]` : "";
      return {
        content: [{ type: "text", text: content + suffix }],
      };
    }

    // ── fs_write ─────────────────────────────────────────────────────────────
    if (name === "fs_write") {
      const target = args.path || args.filename;
      if (!target) throw new Error("fs_write needs 'filename' or 'path'");
      let outPath;
      if (FS_ALLOW_WRITE_ANYWHERE && target.includes("/")) {
        outPath = resolveSafe(target);
        await fs.mkdir(path.dirname(outPath), { recursive: true });
      } else {
        outPath = path.join(OUTPUT_DIR, path.basename(target)); // strip any path traversal
      }
      const flag = args.append ? "a" : "w";
      await fs.writeFile(outPath, args.content, { flag, encoding: "utf8" });
      return {
        content: [{ type: "text", text: `File written: ${outPath}` }],
      };
    }

    // ── fs_delete ────────────────────────────────────────────────────────────
    if (name === "fs_delete") {
      if (!FS_ALLOW_DELETE) throw new Error("fs_delete is disabled (set HERMES_FS_ALLOW_DELETE=true to enable)");
      const safe = resolveSafe(args.path);
      await fs.rm(safe, { recursive: !!args.recursive, force: false });
      return {
        content: [{ type: "text", text: `Deleted: ${safe}` }],
      };
    }

    // ── shell_exec ───────────────────────────────────────────────────────────
    if (name === "shell_exec") {
      const cmd = (args.command || "").trim();
      if (!cmd) throw new Error("Empty command");
      const timeout = args.timeout || 10000;
      const opts = {
        cwd: WORKSPACE_ROOT,
        timeout,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, HOME: WORKSPACE_ROOT },
      };

      // Unrestricted mode: full shell (pipes, redirects, &&).
      if (ALLOW_UNRESTRICTED_SHELL) {
        const { stdout, stderr } = await execFileAsync("bash", ["-lc", cmd], opts);
        return { content: [{ type: "text", text: truncate((stdout || "") + (stderr ? `\nSTDERR:\n${stderr}` : "")) || "(no output)" }] };
      }

      const parts   = cmd.split(/\s+/);
      const binary  = parts[0];
      if (!SHELL_ALLOWLIST.includes(binary)) {
        return {
          content: [{ type: "text", text: `Command '${binary}' is not in the allowlist. Allowed: ${SHELL_ALLOWLIST.join(", ")} (widen with HERMES_ALLOW_SSH / HERMES_SHELL_EXTRA / HERMES_ALLOW_UNRESTRICTED_SHELL)` }],
          isError: true,
        };
      }

      const { stdout, stderr } = await execFileAsync(binary, parts.slice(1), opts);
      const out = truncate((stdout || "") + (stderr ? `\nSTDERR:\n${stderr}` : ""));
      return {
        content: [{ type: "text", text: out || "(no output)" }],
      };
    }

    // ── note_save ────────────────────────────────────────────────────────────
    if (name === "note_save") {
      const text = await saveNote({
        title:   args.title,
        content: args.content,
        folder:  args.folder,
        tags:    args.tags,
        sync:    args.sync,
      });
      return { content: [{ type: "text", text }] };
    }

    // ── ollama_chat ──────────────────────────────────────────────────────────
    if (name === "ollama_chat") {
      const text = await ollamaChat({
        prompt: args.prompt,
        model: args.model,
        system: args.system,
        temperature: args.temperature,
      });
      return { content: [{ type: "text", text }] };
    }

    // ── claude_chat ──────────────────────────────────────────────────────────
    if (name === "claude_chat") {
      // No key → transparently fall back to Ollama (Qwen) unless disabled.
      if (!CLAUDE_API_KEY) {
        if (DISABLE_CLAUDE_FALLBACK) throw new Error("ANTHROPIC_API_KEY not configured");
        console.error(`[claude_chat] no API key — falling back to ollama:${CLAUDE_FALLBACK_MODEL}`);
        const text = await ollamaChat({ prompt: args.prompt, model: CLAUDE_FALLBACK_MODEL, system: args.system, temperature: args.temperature });
        return { content: [{ type: "text", text }] };
      }

      const body = {
        model:      "claude-sonnet-4-6",
        max_tokens: args.max_tokens || 1024,
        messages:   [{ role: "user", content: args.prompt }],
      };
      if (args.system) body.system = args.system;

      try {
        const resp = await fetch(CLAUDE_URL, {
          method: "POST",
          headers: {
            "Content-Type":    "application/json",
            "x-api-key":       CLAUDE_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error(`Claude error ${resp.status}: ${await resp.text()}`);
        const data = await resp.json();
        const text = data.content?.[0]?.text || "(no response)";
        return { content: [{ type: "text", text: truncate(text) }] };
      } catch (err) {
        if (DISABLE_CLAUDE_FALLBACK) throw err;
        console.error(`[claude_chat] Claude failed (${err.message}) — falling back to ollama:${CLAUDE_FALLBACK_MODEL}`);
        const text = await ollamaChat({ prompt: args.prompt, model: CLAUDE_FALLBACK_MODEL, system: args.system, temperature: args.temperature });
        return { content: [{ type: "text", text }] };
      }
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error in ${name}: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Start server ────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Hermes MCP server started. Workspace:", WORKSPACE_ROOT);
console.error("Capabilities:", JSON.stringify({
  ssh: ALLOW_SSH,
  unrestricted_shell: ALLOW_UNRESTRICTED_SHELL,
  fs_unrestricted: FS_UNRESTRICTED,
  fs_write_anywhere: FS_ALLOW_WRITE_ANYWHERE,
  fs_delete: FS_ALLOW_DELETE,
  claude_fallback: CLAUDE_API_KEY ? "claude" : (DISABLE_CLAUDE_FALLBACK ? "none" : `ollama:${CLAUDE_FALLBACK_MODEL}`),
}));
