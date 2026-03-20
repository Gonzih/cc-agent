import { existsSync } from "fs";
import { spawn } from "child_process";
import { EventEmitter } from "events";

export type MessageType = "system" | "assistant" | "user" | "result";

export interface ClaudeMessage {
  type: MessageType;
  session_id?: string;
  payload: Record<string, unknown>;
}

export interface UsageEvent {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface OneShot extends EventEmitter {
  on(event: "message", listener: (msg: ClaudeMessage) => void): this;
  on(event: "text", listener: (text: string) => void): this;
  on(event: "tool", listener: (name: string) => void): this;
  on(event: "session", listener: (sessionId: string) => void): this;
  on(event: "usage", listener: (usage: UsageEvent) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  pid?: number;
  stdin?: import("stream").Writable | null;
}

/**
 * Run Claude Code non-interactively in a directory with a task.
 * Streams JSON output, emits text chunks and structured messages.
 */
export function runClaude(
  task: string,
  cwd: string,
  token?: string,
  options?: { continueSession?: boolean; maxBudgetUsd?: number; sessionId?: string }
): OneShot & { kill: () => void } {
  const emitter = new EventEmitter() as OneShot & { kill: () => void };

  const claudeBin = resolveClaude();

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--max-budget-usd", String(options?.maxBudgetUsd ?? 20),
  ];

  if (options?.continueSession || options?.sessionId) {
    args.push("--continue");
  }

  args.push(task);

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (token) {
    if (token.startsWith("sk-ant-api")) {
      env.ANTHROPIC_API_KEY = token;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
      delete env.ANTHROPIC_API_KEY;
    }
  }

  const proc = spawn(claudeBin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  proc.unref();
  proc.stdin?.end();

  let buffer = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const type = raw.type as MessageType | undefined;
        if (!type) continue;

        const msg: ClaudeMessage = { type, payload: raw };
        if (raw.session_id) msg.session_id = raw.session_id as string;
        emitter.emit("message", msg);

        // Emit session ID on first occurrence
        if (raw.session_id && typeof raw.session_id === "string") {
          emitter.emit("session", raw.session_id);
        }

        // Emit usage from message_start (input tokens for this turn)
        if (raw.type === "message_start") {
          const message = raw.message as Record<string, unknown> | undefined;
          if (message?.usage) {
            const u = message.usage as Record<string, unknown>;
            emitter.emit("usage", {
              inputTokens: (u.input_tokens as number) ?? 0,
              outputTokens: (u.output_tokens as number) ?? 0,
              cacheReadTokens: (u.cache_read_input_tokens as number) ?? 0,
              cacheWriteTokens: (u.cache_creation_input_tokens as number) ?? 0,
            });
          }
        }

        // Emit usage from message_delta (output tokens for this turn)
        if (raw.type === "message_delta" && raw.usage) {
          const u = raw.usage as Record<string, unknown>;
          emitter.emit("usage", {
            inputTokens: 0,
            outputTokens: (u.output_tokens as number) ?? 0,
          });
        }

        // Emit cost_usd from result if provided
        if (raw.type === "result" && raw.cost_usd != null) {
          emitter.emit("usage", {
            inputTokens: 0,
            outputTokens: 0,
            costUsd: raw.cost_usd as number,
          });
        }

        const toolName = extractToolName(msg);
        if (toolName) emitter.emit("tool", toolName);

        const text = extractText(msg);
        if (text) emitter.emit("text", text);
      } catch {
        // non-JSON noise
      }
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    // stderr goes to text as info
    const s = chunk.toString().trim();
    if (s) emitter.emit("text", `[stderr] ${s}`);
  });

  proc.on("error", (err) => emitter.emit("error", err));
  proc.on("exit", (code) => emitter.emit("exit", code));

  emitter.kill = () => proc.kill();
  emitter.pid = proc.pid;
  emitter.stdin = proc.stdin;

  return emitter;
}

export function extractText(msg: ClaudeMessage): string {
  if (msg.type === "result") {
    return (msg.payload.result as string) ?? "";
  }
  const message = msg.payload.message as Record<string, unknown> | undefined;
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text")
      .map((b) => b.text as string)
      .join("");
  }
  return "";
}

function extractToolName(msg: ClaudeMessage): string | null {
  const message = msg.payload.message as Record<string, unknown> | undefined;
  if (!message) return null;
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        return block.name;
      }
    }
  }
  return null;
}

export function resolveClaude(): string {
  const dirs = (process.env.PATH ?? "").split(":");
  for (const dir of dirs) {
    const c = `${dir}/claude`;
    if (existsSync(c)) return c;
  }
  const fallbacks = [
    `${process.env.HOME}/.npm-global/bin/claude`,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const p of fallbacks) {
    if (existsSync(p)) return p;
  }
  return "claude";
}
