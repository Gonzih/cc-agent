import { existsSync } from "fs";
import { spawn } from "child_process";
import { getPricing } from "./pricing.js";
import { BaseAgentProcess } from "./types.js";
import type { AgentDriver, AgentProcess, SpawnOptions, UsageEvent } from "./types.js";

/**
 * AmpDriver wraps the `amp` CLI by Sourcegraph (https://ampcode.com).
 * Spawns: amp --execute "<task>" --stream-json --dangerously-allow-all
 *
 * Amp's --stream-json output is documented as compatible with Claude Code's
 * stream-json schema. Parsing logic mirrors claude.ts accordingly.
 */
export class AmpDriver implements AgentDriver {
  readonly name = "amp";

  resolveBinary(): string {
    const dirs = (process.env.PATH ?? "").split(":");
    for (const dir of dirs) {
      const p = `${dir}/amp`;
      if (existsSync(p)) return p;
    }
    const fallbacks = [
      `${process.env.HOME}/.npm-global/bin/amp`,
      "/opt/homebrew/bin/amp",
      "/usr/local/bin/amp",
      "/usr/bin/amp",
    ];
    for (const p of fallbacks) {
      if (existsSync(p)) return p;
    }
    return "amp";
  }

  hasSession(_cwd: string): boolean {
    return false; // no persistent session support
  }

  spawn(options: SpawnOptions): AgentProcess {
    const bin = this.resolveBinary();

    const args = [
      "--execute", options.task,
      "--stream-json",
      "--dangerously-allow-all",
    ];

    if (options.model) {
      args.push("--model", options.model);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(options.env ?? {}),
    };

    // Map token → AMP_API_KEY
    const apiKey = options.token ?? process.env.AMP_API_KEY;
    if (apiKey) env.AMP_API_KEY = apiKey;

    let killed = false;
    const emitter = new BaseAgentProcess();

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      process.nextTick(() => {
        emitter.emit("text", `[amp] Failed to spawn: ${String(err)}\nInstall with: npm install -g @sourcegraph/amp`);
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
          parseAmpEvent(obj, emitter);
        } catch {
          // non-JSON line — emit as raw text
          if (line.trim()) emitter.emit("text", line);
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s) emitter.emit("text", `[amp stderr] ${s}`);
    });

    proc.on("error", (err) => {
      if (!killed) {
        emitter.emit("text", `[amp] Error: ${err.message}\nInstall with: npm install -g @sourcegraph/amp`);
        emitter.emit("exit", 1);
      }
    });

    proc.on("exit", (code) => {
      if (buf.trim()) {
        try {
          const obj = JSON.parse(buf) as Record<string, unknown>;
          parseAmpEvent(obj, emitter);
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
    const pricing = getPricing(model ?? "amp");
    const cost =
      (usage.inputTokens * pricing.inputPer1M +
        usage.outputTokens * pricing.outputPer1M) /
      1_000_000;
    return Math.round(cost * 10000) / 10000;
  }
}

/**
 * Parse a single NDJSON event from Amp's --stream-json output.
 *
 * Amp's schema is documented as compatible with Claude Code's stream-json format:
 *   - { type: "message_start", message: { usage: { input_tokens, output_tokens, ... } } }
 *   - { type: "message_delta", usage: { output_tokens } }
 *   - { type: "content_block_delta", delta: { type: "text_delta", text: string } }
 *   - { type: "content_block_start", content_block: { type: "tool_use", name: string } }
 *   - { type: "result", result: string, cost_usd?: number }
 *   - { session_id: string } — session identifier
 */
function parseAmpEvent(obj: Record<string, unknown>, emitter: BaseAgentProcess): void {
  const type = obj.type as string | undefined;

  // Session ID (may appear on any message type)
  if (obj.session_id && typeof obj.session_id === "string") {
    emitter.emit("sessionId", obj.session_id);
  }

  // Input token usage from message_start
  if (type === "message_start") {
    const message = obj.message as Record<string, unknown> | undefined;
    if (message?.usage) {
      const u = message.usage as Record<string, unknown>;
      emitter.emit("usage", {
        inputTokens: (u.input_tokens as number) ?? 0,
        outputTokens: (u.output_tokens as number) ?? 0,
        cacheReadTokens: (u.cache_read_input_tokens as number) ?? 0,
        cacheWriteTokens: (u.cache_creation_input_tokens as number) ?? 0,
      } satisfies UsageEvent);
    }
    return;
  }

  // Output token usage from message_delta
  if (type === "message_delta" && obj.usage) {
    const u = obj.usage as Record<string, unknown>;
    emitter.emit("usage", {
      inputTokens: 0,
      outputTokens: (u.output_tokens as number) ?? 0,
    } satisfies UsageEvent);
    return;
  }

  // Text content from streaming delta
  if (type === "content_block_delta") {
    const delta = obj.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
      emitter.emit("text", delta.text);
    }
    return;
  }

  // Tool use from content_block_start
  if (type === "content_block_start") {
    const block = obj.content_block as Record<string, unknown> | undefined;
    if (block?.type === "tool_use" && typeof block.name === "string") {
      emitter.emit("tool", block.name);
    }
    return;
  }

  // Final result message
  if (type === "result") {
    if (typeof obj.result === "string" && obj.result) {
      emitter.emit("text", obj.result);
    }
    if (obj.cost_usd != null) {
      emitter.emit("usage", {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: obj.cost_usd as number,
      } satisfies UsageEvent);
    }
    return;
  }

  // assistant message with content array (non-streaming shape)
  if (type === "assistant") {
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) return;
    const content = message.content;
    if (typeof content === "string" && content) {
      emitter.emit("text", content);
    } else if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          emitter.emit("text", block.text);
        }
        if (block.type === "tool_use" && typeof block.name === "string") {
          emitter.emit("tool", block.name);
        }
      }
    }
    return;
  }
}
