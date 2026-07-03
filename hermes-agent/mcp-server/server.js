#!/usr/bin/env node
/**
 * Hermes MCP Server
 * Exposes filesystem, shell, and API tools to the agent.
 * Runs inside a sandbox with controlled bind mounts.
 *
 * Available tools:
 *   fs_list      — ls a directory inside the workspace
 *   fs_read      — read a file
 *   fs_write     — write a file (only under /workspace/output)
 *   shell_exec   — run a command in /workspace (allowlist)
 *   ollama_chat  — call Ollama via API
 *   claude_chat  — call the Claude API
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

// Commands allowed in shell_exec — add the ones you need
const SHELL_ALLOWLIST = [
  "ls", "find", "cat", "head", "tail", "grep", "wc",
  "pwd", "echo", "date", "df", "du", "stat",
  "python3", "node", "jq", "curl",
  "git", "npm", "pip3",
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function assertInWorkspace(filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(WORKSPACE_ROOT))) {
    throw new Error(`Access denied: '${filePath}' is outside ${WORKSPACE_ROOT}`);
  }
  return resolved;
}

function truncate(text, max = MAX_OUTPUT_LEN) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated, ${text.length - max} more chars]`;
}

// ── Initialize output dir ───────────────────────────────────────────────────
await fs.mkdir(OUTPUT_DIR, { recursive: true });

// ── Server ────────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "hermes-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Tool list ─────────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "fs_list",
      description: "List files and directories inside the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Relative or absolute path inside /workspace. Default: /workspace" },
        },
      },
    },
    {
      name: "fs_read",
      description: "Read the contents of a file inside the workspace.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "File path inside /workspace" },
          max_bytes: { type: "number", description: "Maximum bytes to read (default 32768)" },
        },
      },
    },
    {
      name: "fs_write",
      description: "Write a file under /workspace/output/. Writing is only allowed in this directory.",
      inputSchema: {
        type: "object",
        required: ["filename", "content"],
        properties: {
          filename: { type: "string", description: "File name (no path)" },
          content:  { type: "string", description: "Content to write" },
          append:   { type: "boolean", description: "If true, append to the end of the file" },
        },
      },
    },
    {
      name: "shell_exec",
      description: `Run a command in the workspace. Allowlisted commands only: ${SHELL_ALLOWLIST.join(", ")}`,
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
      description: "Send a prompt to the Claude API (Anthropic). Use for top quality, final posts, complex analysis.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt:    { type: "string", description: "Message to the model" },
          system:    { type: "string", description: "Optional system prompt" },
          max_tokens: { type: "number", description: "Maximum tokens (default: 1024)" },
        },
      },
    },
  ],
}));

// ── Tool handlers ─────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // ── fs_list ──────────────────────────────────────────────────────────────
    if (name === "fs_list") {
      const dir = args.dir || WORKSPACE_ROOT;
      const safe = assertInWorkspace(dir);
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
      const safe = assertInWorkspace(args.path);
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
      const filename = path.basename(args.filename); // strip any path traversal
      const outPath  = path.join(OUTPUT_DIR, filename);
      const flag     = args.append ? "a" : "w";
      await fs.writeFile(outPath, args.content, { flag, encoding: "utf8" });
      return {
        content: [{ type: "text", text: `File written: ${outPath}` }],
      };
    }

    // ── shell_exec ───────────────────────────────────────────────────────────
    if (name === "shell_exec") {
      const parts   = args.command.trim().split(/\s+/);
      const binary  = parts[0];
      const cmdArgs = parts.slice(1);

      if (!SHELL_ALLOWLIST.includes(binary)) {
        return {
          content: [{ type: "text", text: `Command '${binary}' is not in the allowlist. Allowed: ${SHELL_ALLOWLIST.join(", ")}` }],
          isError: true,
        };
      }

      const timeout = args.timeout || 10000;
      const { stdout, stderr } = await execFileAsync(binary, cmdArgs, {
        cwd: WORKSPACE_ROOT,
        timeout,
        maxBuffer: 1024 * 512,
        env: { ...process.env, HOME: WORKSPACE_ROOT },
      });

      const out = truncate((stdout || "") + (stderr ? `\nSTDERR:\n${stderr}` : ""));
      return {
        content: [{ type: "text", text: out || "(no output)" }],
      };
    }

    // ── ollama_chat ──────────────────────────────────────────────────────────
    if (name === "ollama_chat") {
      const model    = args.model || "qwen3.5:4b";
      const messages = [];
      if (args.system) messages.push({ role: "system", content: args.system });
      messages.push({ role: "user", content: args.prompt });

      const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          messages,
          options: { temperature: args.temperature ?? 0.7 },
        }),
      });
      if (!resp.ok) throw new Error(`Ollama error ${resp.status}: ${await resp.text()}`);
      const data = await resp.json();
      const text = data.message?.content || "(no response)";
      return { content: [{ type: "text", text: truncate(text) }] };
    }

    // ── claude_chat ──────────────────────────────────────────────────────────
    if (name === "claude_chat") {
      if (!CLAUDE_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
      const body = {
        model:      "claude-sonnet-4-6",
        max_tokens: args.max_tokens || 1024,
        messages:   [{ role: "user", content: args.prompt }],
      };
      if (args.system) body.system = args.system;

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
