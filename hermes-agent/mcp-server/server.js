#!/usr/bin/env node
/**
 * Hermes MCP Server
 * Expone tools de filesystem, shell y APIs al agente.
 * Corre dentro de un sandbox con bind mounts controlados.
 *
 * Tools disponibles:
 *   fs_list      — ls de un directorio dentro del workspace
 *   fs_read      — leer un archivo
 *   fs_write     — escribir un archivo (solo en /workspace/output)
 *   shell_exec   — ejecutar un comando en /workspace (allowlist)
 *   ollama_chat  — llamar a Ollama por API
 *   claude_chat  — llamar a Claude API
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

// ── Configuración ─────────────────────────────────────────────────────────────
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || "/workspace";
const OUTPUT_DIR     = path.join(WORKSPACE_ROOT, "output");
const OLLAMA_URL     = process.env.OLLAMA_URL     || "http://sram:11434";
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_URL     = "https://api.anthropic.com/v1/messages";
const MAX_OUTPUT_LEN = 8000;

// Comandos permitidos en shell_exec — agrega los que necesites
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
    throw new Error(`Acceso denegado: '${filePath}' está fuera de ${WORKSPACE_ROOT}`);
  }
  return resolved;
}

function truncate(text, max = MAX_OUTPUT_LEN) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncado, ${text.length - max} chars más]`;
}

// ── Inicializar output dir ────────────────────────────────────────────────────
await fs.mkdir(OUTPUT_DIR, { recursive: true });

// ── Server ────────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "hermes-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Lista de tools ────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "fs_list",
      description: "Lista archivos y directorios dentro del workspace.",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Ruta relativa o absoluta dentro de /workspace. Default: /workspace" },
        },
      },
    },
    {
      name: "fs_read",
      description: "Lee el contenido de un archivo dentro del workspace.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Ruta del archivo dentro de /workspace" },
          max_bytes: { type: "number", description: "Máximo de bytes a leer (default 32768)" },
        },
      },
    },
    {
      name: "fs_write",
      description: "Escribe un archivo en /workspace/output/. Solo se puede escribir en este directorio.",
      inputSchema: {
        type: "object",
        required: ["filename", "content"],
        properties: {
          filename: { type: "string", description: "Nombre del archivo (sin path)" },
          content:  { type: "string", description: "Contenido a escribir" },
          append:   { type: "boolean", description: "Si true, agrega al final del archivo" },
        },
      },
    },
    {
      name: "shell_exec",
      description: `Ejecuta un comando en el workspace. Solo comandos de la allowlist: ${SHELL_ALLOWLIST.join(", ")}`,
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string", description: "Comando a ejecutar (ej: 'ls -la /workspace')" },
          timeout: { type: "number", description: "Timeout en ms (default 10000)" },
        },
      },
    },
    {
      name: "ollama_chat",
      description: "Envía un prompt a Ollama (LLM local en Sram). Usa para tareas privadas, batch o routing.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt:      { type: "string", description: "Mensaje al modelo" },
          model:       { type: "string", description: "Modelo Ollama (default: qwen3.5:4b)" },
          system:      { type: "string", description: "System prompt opcional" },
          temperature: { type: "number", description: "Temperatura (default: 0.7)" },
        },
      },
    },
    {
      name: "claude_chat",
      description: "Envía un prompt a Claude API (Anthropic). Usa para calidad máxima, posts finales, análisis complejos.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt:    { type: "string", description: "Mensaje al modelo" },
          system:    { type: "string", description: "System prompt opcional" },
          max_tokens: { type: "number", description: "Máximo de tokens (default: 1024)" },
        },
      },
    },
  ],
}));

// ── Handlers de tools ─────────────────────────────────────────────────────────
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
        content: [{ type: "text", text: `Contenido de ${safe}:\n${lines.join("\n") || "(vacío)"}` }],
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
      const suffix = bytesRead === maxBytes ? `\n… [truncado, lee más con max_bytes mayor]` : "";
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
        content: [{ type: "text", text: `Archivo escrito: ${outPath}` }],
      };
    }

    // ── shell_exec ───────────────────────────────────────────────────────────
    if (name === "shell_exec") {
      const parts   = args.command.trim().split(/\s+/);
      const binary  = parts[0];
      const cmdArgs = parts.slice(1);

      if (!SHELL_ALLOWLIST.includes(binary)) {
        return {
          content: [{ type: "text", text: `Comando '${binary}' no está en la allowlist. Permitidos: ${SHELL_ALLOWLIST.join(", ")}` }],
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
        content: [{ type: "text", text: out || "(sin output)" }],
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
      const text = data.message?.content || "(sin respuesta)";
      return { content: [{ type: "text", text: truncate(text) }] };
    }

    // ── claude_chat ──────────────────────────────────────────────────────────
    if (name === "claude_chat") {
      if (!CLAUDE_API_KEY) throw new Error("ANTHROPIC_API_KEY no configurado");
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
      const text = data.content?.[0]?.text || "(sin respuesta)";
      return { content: [{ type: "text", text: truncate(text) }] };
    }

    return {
      content: [{ type: "text", text: `Tool desconocida: ${name}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error en ${name}: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Iniciar server ────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Hermes MCP server iniciado. Workspace:", WORKSPACE_ROOT);
