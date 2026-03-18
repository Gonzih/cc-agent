import { existsSync } from "fs";
import { spawn } from "child_process";
import { EventEmitter } from "events";

export type MessageType = "system" | "assistant" | "user" | "result";

export interface ClaudeMessage {
  type: MessageType;
  session_id?: string;
  payload: Record<string, unknown>;
}

export interface OneShot extends EventEmitter {
  on(event: "message", listener: (msg: ClaudeMessage) => void): this;
  on(event: "text", listener: (text: string) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  pid?: number;
}

/**
 * Run Claude Code non-interactively in a directory with a task.
 * Streams JSON output, emits text chunks and structured messages.
 */
export function runClaude(
  task: string,
  cwd: string,
  token?: string
): OneShot & { kill: () => void } {
  const emitter = new EventEmitter() as OneShot & { kill: () => void };

  const claudeBin = resolveClaude();

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
    "--verbose",
    task,
  ];

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

  const proc = spawn(claudeBin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  proc.unref();

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

  return emitter;
}

function extractText(msg: ClaudeMessage): string {
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

function resolveClaude(): string {
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
