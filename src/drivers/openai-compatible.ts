/**
 * OpenAICompatibleDriver — embedded agentic loop for any OpenAI-API-compatible model.
 *
 * Supports: OpenAI, Qwen, Kimi, DeepSeek, Pi, and any other provider with an
 * OpenAI-compatible /v1/chat/completions endpoint.
 *
 * The driver runs a tool-call loop inside cc-agent itself:
 *   1. Call model API with messages + tool definitions
 *   2. If model calls a tool → execute in cwd → append result → continue
 *   3. If model returns text → emit as text events
 *   4. If model outputs TASK_COMPLETE → terminate loop
 *   5. Track token usage → emit usage events
 *
 * Security: tool execution has a 30s timeout; output is truncated to 8000 chars.
 * Max 50 iterations to prevent runaway loops.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, readdir } from "fs/promises";
import { join, isAbsolute, resolve, relative } from "path";
import { existsSync } from "fs";
import { getPricing } from "./pricing.js";
import { BaseAgentProcess } from "./types.js";
import type { AgentDriver, AgentProcess, SpawnOptions, UsageEvent } from "./types.js";

const execFileAsync = promisify(execFile);

const TOOL_TIMEOUT_MS = 30_000;
const MAX_ITERATIONS = 50;
const OUTPUT_MAX_CHARS = 8_000;

// ── Driver name → (env key, default base URL) ──────────────────────────────
const DRIVER_CONFIG: Record<string, { envKey: string; baseUrl: string }> = {
  qwen:      { envKey: "QWEN_API_KEY",     baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  kimi:      { envKey: "KIMI_API_KEY",     baseUrl: "https://api.moonshot.cn/v1" },
  deepseek:  { envKey: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com/v1" },
  pi:        { envKey: "PI_API_KEY",       baseUrl: "https://api.inflection.ai/v1" },
  openai:    { envKey: "OPENAI_API_KEY",   baseUrl: "https://api.openai.com/v1" },
  "openai-compatible": { envKey: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" },
};

const DEFAULT_MODELS: Record<string, string> = {
  qwen:     "qwen2.5-72b-instruct",
  kimi:     "kimi-k2",
  deepseek: "deepseek-v3",
  pi:       "inflection_3_productivity",
  openai:   "gpt-4o",
  "openai-compatible": "gpt-4o",
};

const SYSTEM_PROMPT = `You are an autonomous coding agent. You have access to the following tools to complete tasks in a working directory:
- bash(command): Run any shell command. Returns stdout+stderr.
- write_file(path, content): Write content to a file (creates directories as needed).
- read_file(path): Read a file's content.
- list_files(path): List files in a directory.

Complete the given task autonomously. When you have fully completed the task, output exactly: TASK_COMPLETE

Rules:
- Work only within the provided working directory
- Do not read files outside the working directory
- After completing all work, output TASK_COMPLETE on its own line`;

const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "bash",
      description: "Run a shell command in the working directory. Returns stdout and stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write content to a file path relative to the working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to working directory)" },
          content: { type: "string", description: "File content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read the content of a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to working directory)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description: "List files and directories at a path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (relative to working directory, default '.')" },
        },
      },
    },
  },
];

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ApiResponse {
  id?: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenAICompatibleDriver implements AgentDriver {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  resolveBinary(): string {
    return ""; // no binary — uses HTTP API
  }

  hasSession(_cwd: string): boolean {
    return false; // no persistent session for API agents
  }

  spawn(options: SpawnOptions): AgentProcess {
    const emitter = new BaseAgentProcess();
    let killed = false;

    emitter.kill = (_signal?: string) => {
      killed = true;
    };

    (async () => {
      try {
        await this.runLoop(options, emitter as BaseAgentProcess, () => killed);
      } catch (err) {
        (emitter as BaseAgentProcess).emit("text", `[${this.name}] Fatal error: ${String(err)}`);
        (emitter as BaseAgentProcess).emit("exit", 1);
      }
    })();

    return emitter;
  }

  private resolveApiKey(options: SpawnOptions): string {
    // Per-call override takes highest precedence
    if (options.env?.OPENAI_API_KEY) return options.env.OPENAI_API_KEY;
    if (options.token) return options.token;

    const cfg = DRIVER_CONFIG[this.name] ?? DRIVER_CONFIG.openai;
    const fromEnv = process.env[cfg.envKey] ?? process.env.OPENAI_API_KEY;
    if (fromEnv) return fromEnv;

    throw new Error(
      `No API key found for driver '${this.name}'. ` +
      `Set ${cfg.envKey} or OPENAI_API_KEY environment variable.`
    );
  }

  private resolveBaseUrl(options: SpawnOptions): string {
    if (options.env?.OPENAI_BASE_URL) return options.env.OPENAI_BASE_URL.replace(/\/$/, "");
    const fromEnv = process.env.OPENAI_BASE_URL;
    if (fromEnv) return fromEnv.replace(/\/$/, "");
    const cfg = DRIVER_CONFIG[this.name] ?? DRIVER_CONFIG.openai;
    return cfg.baseUrl;
  }

  private resolveModel(options: SpawnOptions): string {
    if (options.model) return options.model;
    return DEFAULT_MODELS[this.name] ?? "gpt-4o";
  }

  /** Resolve a user-provided path safely within cwd. */
  private safePath(cwd: string, userPath: string): string {
    const p = isAbsolute(userPath) ? userPath : resolve(cwd, userPath);
    // Ensure path is within cwd
    const rel = relative(cwd, p);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path '${userPath}' is outside the working directory`);
    }
    return p;
  }

  private async executeTool(
    cwd: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string> {
    if (toolName === "bash") {
      const command = String(args.command ?? "");
      if (!command.trim()) return "(empty command)";
      try {
        const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
          cwd,
          timeout: TOOL_TIMEOUT_MS,
          maxBuffer: 1024 * 1024, // 1MB
        });
        const combined = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : "")).trim();
        return combined.slice(0, OUTPUT_MAX_CHARS) + (combined.length > OUTPUT_MAX_CHARS ? "\n[output truncated]" : "");
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
        if (e.killed) return `[error] Command timed out after ${TOOL_TIMEOUT_MS / 1000}s`;
        const out = ((e.stdout ?? "") + (e.stderr ? `\nSTDERR:\n${e.stderr}` : "")).trim();
        return (out || String(e.message ?? err)).slice(0, OUTPUT_MAX_CHARS);
      }
    }

    if (toolName === "write_file") {
      const path = this.safePath(cwd, String(args.path ?? ""));
      const content = String(args.content ?? "");
      // Create parent directories if needed
      const { mkdir } = await import("fs/promises");
      const { dirname } = await import("path");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");
      return `Wrote ${content.length} bytes to ${args.path}`;
    }

    if (toolName === "read_file") {
      const path = this.safePath(cwd, String(args.path ?? ""));
      if (!existsSync(path)) return `File not found: ${args.path}`;
      const content = await readFile(path, "utf-8");
      return content.slice(0, OUTPUT_MAX_CHARS) + (content.length > OUTPUT_MAX_CHARS ? "\n[truncated]" : "");
    }

    if (toolName === "list_files") {
      const dirPath = this.safePath(cwd, String(args.path ?? "."));
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });
        return entries
          .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
          .join("\n");
      } catch (err) {
        return `Error listing directory: ${String(err)}`;
      }
    }

    return `Unknown tool: ${toolName}`;
  }

  private async runLoop(
    options: SpawnOptions,
    emitter: BaseAgentProcess,
    isKilled: () => boolean
  ): Promise<void> {
    const apiKey = this.resolveApiKey(options);
    const baseUrl = this.resolveBaseUrl(options);
    const model = this.resolveModel(options);

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Working directory: ${options.cwd}\n\nTask:\n${options.task}` },
    ];

    emitter.emit("text", `[${this.name}] Starting with model ${model} at ${baseUrl}`);

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (isKilled()) {
        emitter.emit("exit", null);
        return;
      }

      // Call the API
      let response: ApiResponse;
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            tools: TOOL_DEFINITIONS,
            tool_choice: "auto",
            max_tokens: 4096,
          }),
          signal: AbortSignal.timeout(120_000), // 2 minute HTTP timeout
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`API error ${res.status}: ${body.slice(0, 500)}`);
        }

        response = await res.json() as ApiResponse;
      } catch (err) {
        emitter.emit("text", `[${this.name}] API error: ${String(err)}`);
        emitter.emit("exit", 1);
        return;
      }

      // Emit usage if available
      if (response.usage) {
        const u: UsageEvent = {
          inputTokens: response.usage.prompt_tokens ?? 0,
          outputTokens: response.usage.completion_tokens ?? 0,
        };
        emitter.emit("usage", u);
      }

      const choice = response.choices[0];
      if (!choice) {
        emitter.emit("text", `[${this.name}] Empty response from API`);
        emitter.emit("exit", 1);
        return;
      }

      const msg = choice.message;

      // Emit any text content
      if (msg.content) {
        emitter.emit("text", msg.content);
        if (/TASK_COMPLETE/i.test(msg.content)) {
          emitter.emit("exit", 0);
          return;
        }
      }

      // Handle tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Add assistant message with tool calls to history
        messages.push({
          role: "assistant",
          content: msg.content ?? null,
          tool_calls: msg.tool_calls,
        });

        for (const tc of msg.tool_calls) {
          if (isKilled()) {
            emitter.emit("exit", null);
            return;
          }

          const toolName = tc.function.name;
          let toolArgs: Record<string, unknown> = {};
          try {
            toolArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            toolArgs = {};
          }

          emitter.emit("tool", toolName);

          let toolResult: string;
          try {
            toolResult = await this.executeTool(options.cwd, toolName, toolArgs);
          } catch (err) {
            toolResult = `Tool error: ${String(err)}`;
          }

          messages.push({
            role: "tool",
            content: toolResult,
            tool_call_id: tc.id,
          });
        }

        // Continue the loop to let the model react to tool results
        continue;
      }

      // finish_reason === "stop" with no tool calls — model is done
      if (choice.finish_reason === "stop" || !msg.tool_calls) {
        emitter.emit("exit", 0);
        return;
      }
    }

    emitter.emit("text", `[${this.name}] Max iterations (${MAX_ITERATIONS}) reached`);
    emitter.emit("exit", 1);
  }

  estimateCost(usage: UsageEvent, model?: string): number {
    if (usage.costUsd != null) return usage.costUsd;
    const pricing = getPricing(model ?? DEFAULT_MODELS[this.name] ?? "gpt-4o");
    const cost =
      (usage.inputTokens * pricing.inputPer1M +
        usage.outputTokens * pricing.outputPer1M) /
      1_000_000;
    return Math.round(cost * 10000) / 10000;
  }
}
