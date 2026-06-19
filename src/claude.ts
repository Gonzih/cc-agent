import { existsSync, openSync, closeSync, readSync, fstatSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { join } from "path";
import { tmpdir } from "os";

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
  logPath?: string;
  stdin?: import("stream").Writable | null;
}

function getLogsDir(): string {
  const dir = join(tmpdir(), "cc-agent-jobs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isPidAliveLocal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === "EPERM") return true;
    return false;
  }
}

/** Parse a single JSONL line and emit events on the provided emitter. */
function processLine(line: string, emitter: EventEmitter): void {
  if (!line.trim()) return;
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const type = raw.type as MessageType | undefined;
    if (!type) return;

    const msg: ClaudeMessage = { type, payload: raw };
    if (raw.session_id) msg.session_id = raw.session_id as string;
    emitter.emit("message", msg);

    if (raw.session_id && typeof raw.session_id === "string") {
      emitter.emit("session", raw.session_id);
    }

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

    if (raw.type === "message_delta" && raw.usage) {
      const u = raw.usage as Record<string, unknown>;
      emitter.emit("usage", {
        inputTokens: 0,
        outputTokens: (u.output_tokens as number) ?? 0,
      });
    }

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
    // non-JSON noise — ignore
  }
}

function drainFile(logPath: string, offset: number, emitter: EventEmitter): number {
  try {
    const fd = openSync(logPath, "r");
    const { size } = fstatSync(fd);
    if (size <= offset) { closeSync(fd); return offset; }
    const chunk = Buffer.alloc(size - offset);
    readSync(fd, chunk, 0, chunk.length, offset);
    closeSync(fd);
    const text = chunk.toString("utf8");
    const lines = text.split("\n");
    for (const line of lines) processLine(line, emitter);
    return size;
  } catch {
    return offset;
  }
}

/**
 * Tail a log file and emit parsed JSONL events.
 * Used both for initial runs AND to re-attach after cc-agent restarts.
 * When pid is provided, polls isPidAliveLocal() and emits "exit" when the process dies.
 */
export function tailLogFile(
  logPath: string,
  initialOffset: number,
  pid: number | undefined
): OneShot & { kill: () => void } {
  const emitter = new EventEmitter() as OneShot & { kill: () => void };
  let offset = initialOffset;
  let buffer = "";
  let stopped = false;
  let exitEmitted = false;

  const emitExit = (code: number | null) => {
    if (exitEmitted) return;
    exitEmitted = true;
    stopped = true;
    emitter.emit("exit", code);
  };

  const poll = setInterval(() => {
    if (stopped) { clearInterval(poll); return; }

    // Read new bytes from log file
    try {
      const fd = openSync(logPath, "r");
      const { size } = fstatSync(fd);
      if (size > offset) {
        const chunk = Buffer.alloc(size - offset);
        readSync(fd, chunk, 0, chunk.length, offset);
        offset = size;
        closeSync(fd);
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line, emitter);
      } else {
        closeSync(fd);
      }
    } catch {
      // log file not yet available — normal on first few polls
    }

    // Check PID liveness
    if (pid && !isPidAliveLocal(pid)) {
      clearInterval(poll);
      stopped = true;
      // Final drain: wait 300ms for any buffered writes to flush to disk
      setTimeout(() => {
        offset = drainFile(logPath, offset, emitter);
        // Flush remaining buffer
        const remaining = buffer.split("\n");
        buffer = "";
        for (const line of remaining) processLine(line, emitter);
        emitExit(null);
      }, 300);
    }
  }, 500);

  (poll as unknown as NodeJS.Timeout).unref();

  emitter.kill = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
  };
  emitter.pid = pid;
  emitter.logPath = logPath;

  return emitter;
}

/**
 * Run Claude Code non-interactively in a directory with a task.
 * Writes stdout/stderr to a log file (file-based I/O) so the subprocess survives
 * cc-agent MCP server restarts. Streams parsed events via the returned emitter.
 */
export function runClaude(
  task: string,
  cwd: string,
  token?: string,
  options?: {
    continueSession?: boolean;
    maxBudgetUsd?: number;
    sessionId?: string;
    model?: string;
    ollamaModel?: string;
    ollamaHost?: string;
    jobId?: string;
  }
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
  if (options?.ollamaModel) {
    const ollamaHost = options.ollamaHost ?? "http://localhost:11434";
    env.ANTHROPIC_BASE_URL = `${ollamaHost}/v1`;
    env.ANTHROPIC_API_KEY = "ollama";
    env.CLAUDE_MODEL = options.ollamaModel;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    if (token) {
      if (token.startsWith("sk-ant-api")) {
        env.ANTHROPIC_API_KEY = token;
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        env.CLAUDE_CODE_OAUTH_TOKEN = token;
        delete env.ANTHROPIC_API_KEY;
      }
    }
    if (options?.model) {
      env.CLAUDE_MODEL = options.model;
    } else if (process.env.CC_AGENT_DEFAULT_MODEL) {
      env.CLAUDE_MODEL = process.env.CC_AGENT_DEFAULT_MODEL;
    }
  }

  // Open log file — Claude stdout/stderr write here.
  // File descriptor is inherited by the child process; we close our copy after fork.
  const logPath = join(
    getLogsDir(),
    `${options?.jobId ?? `job-${Date.now()}`}.jsonl`
  );
  const logFd = openSync(logPath, "a");

  const proc = spawn(claudeBin, args, {
    cwd,
    env,
    stdio: ["pipe", logFd, logFd],  // stdin pipe (immediately ended), stdout/stderr → file
    detached: true,
  });
  proc.unref();
  proc.stdin?.end();
  closeSync(logFd);  // Close our copy; child keeps its own inherited fd

  // Tail the log file for parsed events
  const tail = tailLogFile(logPath, 0, proc.pid);

  // Forward all events from tail to our emitter
  tail.on("message", (msg) => emitter.emit("message", msg));
  tail.on("text", (text) => emitter.emit("text", text));
  tail.on("tool", (name) => emitter.emit("tool", name));
  tail.on("session", (id) => emitter.emit("session", id));
  tail.on("usage", (u) => emitter.emit("usage", u));

  let exitEmitted = false;
  const emitExit = (code: number | null) => {
    if (exitEmitted) return;
    exitEmitted = true;
    tail.kill();
    emitter.emit("exit", code);
  };

  // Fast path: proc.on("exit") fires if cc-agent is still alive when Claude finishes
  proc.on("exit", (code) => emitExit(code));

  // Slow path: tail poller detects PID death (cross-session restart case)
  tail.on("exit", (code) => emitExit(code));

  proc.on("error", (err) => emitter.emit("error", err));

  emitter.kill = () => {
    tail.kill();
    try { process.kill(-proc.pid!, "SIGTERM"); } catch {}
    try { proc.kill(); } catch {}
  };
  emitter.pid = proc.pid;
  emitter.logPath = logPath;
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
        const name = block.name;
        const input = (block.input as Record<string, unknown>) || {};
        const arg =
          input.file_path ||
          input.path ||
          input.command ||
          input.pattern ||
          input.query ||
          input.url ||
          "";
        const argStr = typeof arg === "string" ? ` ${arg.slice(0, 60)}` : "";
        return `${name}${argStr}`;
      }
    }
  }
  return null;
}

export function resolveClaude(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
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
