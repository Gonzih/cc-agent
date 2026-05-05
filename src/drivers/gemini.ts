import { existsSync } from "fs";
import { spawn } from "child_process";
import { getPricing } from "./pricing.js";
import { BaseAgentProcess } from "./types.js";
import type { AgentDriver, AgentProcess, SpawnOptions, UsageEvent } from "./types.js";

/**
 * GeminiDriver wraps the `gemini` CLI (https://github.com/google-gemini/gemini-cli).
 * Spawns: gemini -p "<task>" --output-format stream-json --yolo [-m <model>]
 *
 * Parses NDJSON output emitting text, tool, usage, and exit events.
 * The stream-json schema emits objects with a `type` field; text content
 * appears under various field names depending on CLI version.
 */
export class GeminiDriver implements AgentDriver {
  readonly name = "gemini";

  resolveBinary(): string {
    const dirs = (process.env.PATH ?? "").split(":");
    for (const dir of dirs) {
      const p = `${dir}/gemini`;
      if (existsSync(p)) return p;
    }
    const fallbacks = [
      `${process.env.HOME}/.npm-global/bin/gemini`,
      "/opt/homebrew/bin/gemini",
      "/usr/local/bin/gemini",
      "/usr/bin/gemini",
    ];
    for (const p of fallbacks) {
      if (existsSync(p)) return p;
    }
    return "gemini";
  }

  hasSession(_cwd: string): boolean {
    return false; // no persistent session support
  }

  spawn(options: SpawnOptions): AgentProcess {
    const bin = this.resolveBinary();
    const model = options.model ?? "gemini-2.5-pro";

    const args = [
      "-p", options.task,
      "--output-format", "stream-json",
      "--yolo",
      "-m", model,
    ];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(options.env ?? {}),
    };

    // Map token → GEMINI_API_KEY
    const apiKey = options.token ?? process.env.GEMINI_API_KEY;
    if (apiKey) env.GEMINI_API_KEY = apiKey;

    let killed = false;
    const emitter = new BaseAgentProcess();

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      process.nextTick(() => {
        emitter.emit("text", `[gemini] Failed to spawn: ${String(err)}\nInstall with: npm install -g @google/gemini-cli`);
        emitter.emit("exit", 1);
      });
      emitter.kill = () => { killed = true; };
      return emitter;
    }

    emitter.pid = proc.pid;

    let buf = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          parseGeminiEvent(obj, emitter);
        } catch {
          // non-JSON line — emit as raw text
          if (line.trim()) emitter.emit("text", line);
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s) emitter.emit("text", `[gemini stderr] ${s}`);
    });

    proc.on("error", (err) => {
      if (!killed) {
        emitter.emit("text", `[gemini] Error: ${err.message}\nInstall with: npm install -g @google/gemini-cli`);
        emitter.emit("exit", 1);
      }
    });

    proc.on("exit", (code) => {
      if (buf.trim()) {
        try {
          const obj = JSON.parse(buf) as Record<string, unknown>;
          parseGeminiEvent(obj, emitter);
        } catch {
          emitter.emit("text", buf.trim());
        }
      }
      if (!killed) emitter.emit("exit", code);
    });

    emitter.kill = (signal?: string) => {
      killed = true;
      try { proc.kill((signal ?? "SIGTERM") as NodeJS.Signals); } catch {}
    };

    emitter.writeStdin = (data: string) => {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(data);
      }
    };

    return emitter;
  }

  estimateCost(usage: UsageEvent, model?: string): number {
    if (usage.costUsd != null) return usage.costUsd;
    const pricing = getPricing(model ?? "gemini-2.5-pro");
    const cost =
      (usage.inputTokens * pricing.inputPer1M +
        usage.outputTokens * pricing.outputPer1M) /
      1_000_000;
    return Math.round(cost * 10000) / 10000;
  }
}

/**
 * Parse a single NDJSON event from the Gemini CLI stream-json output.
 *
 * The Gemini CLI stream-json schema emits objects with a `type` field.
 * Known event shapes:
 *   - { type: "content", value: string }  — text content chunk
 *   - { type: "tool_call", name: string } — tool invocation
 *   - { type: "usage", inputTokens: number, outputTokens: number } — token usage
 *   - { type: "error", message: string }  — error from the CLI
 *   - { usageMetadata: { promptTokenCount, candidatesTokenCount } } — Gemini API usage metadata
 *   - { candidates: [{ content: { parts: [{ text: string }] } }] } — raw API response shape
 *
 * We apply best-effort matching since the schema is not formally documented.
 */
function parseGeminiEvent(obj: Record<string, unknown>, emitter: BaseAgentProcess): void {
  const type = obj.type as string | undefined;

  // Structured stream-json events
  if (type === "content") {
    const value = obj.value ?? obj.text ?? obj.content;
    if (typeof value === "string" && value) emitter.emit("text", value);
    return;
  }

  if (type === "tool_call" || type === "tool_use" || type === "tool") {
    const name = (obj.name ?? obj.tool_name ?? obj.toolName) as string | undefined;
    if (name) emitter.emit("tool", name);
    return;
  }

  if (type === "usage") {
    const u: UsageEvent = {
      inputTokens: (obj.inputTokens as number) ?? (obj.input_tokens as number) ?? 0,
      outputTokens: (obj.outputTokens as number) ?? (obj.output_tokens as number) ?? 0,
    };
    emitter.emit("usage", u);
    return;
  }

  if (type === "error") {
    const msg = (obj.message ?? obj.error ?? obj.text) as string | undefined;
    if (msg) emitter.emit("text", `[gemini error] ${msg}`);
    return;
  }

  // Gemini API usageMetadata shape (may appear in raw API pass-through)
  if (obj.usageMetadata && typeof obj.usageMetadata === "object") {
    const meta = obj.usageMetadata as Record<string, unknown>;
    const inputTokens = (meta.promptTokenCount as number) ?? 0;
    const outputTokens = (meta.candidatesTokenCount as number) ?? 0;
    if (inputTokens || outputTokens) {
      emitter.emit("usage", { inputTokens, outputTokens });
    }
  }

  // Raw Gemini API candidates shape
  if (Array.isArray(obj.candidates)) {
    for (const candidate of obj.candidates as Array<Record<string, unknown>>) {
      const content = candidate.content as Record<string, unknown> | undefined;
      if (!content) continue;
      const parts = content.parts as Array<Record<string, unknown>> | undefined;
      if (!parts) continue;
      for (const part of parts) {
        if (typeof part.text === "string" && part.text) {
          emitter.emit("text", part.text);
        }
        if (part.functionCall && typeof part.functionCall === "object") {
          const fc = part.functionCall as Record<string, unknown>;
          if (typeof fc.name === "string") emitter.emit("tool", fc.name);
        }
      }
    }
    return;
  }

  // Plain text fallback for unknown shapes with a text/content/value field
  if (!type) {
    const text = obj.text ?? obj.content ?? obj.value ?? obj.message;
    if (typeof text === "string" && text.trim()) emitter.emit("text", text);
  }
}
