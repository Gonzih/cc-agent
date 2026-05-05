import { existsSync } from "fs";
import { spawn } from "child_process";
import { getPricing } from "./pricing.js";
import { BaseAgentProcess } from "./types.js";
import type { AgentDriver, AgentProcess, SpawnOptions, UsageEvent } from "./types.js";

/**
 * CodexDriver wraps the OpenAI Codex CLI (https://github.com/openai/codex).
 * Spawns: codex exec "<task>" [--model <model>] --full-auto
 *
 * Codex CLI produces plain text output only — no JSON stream mode.
 * Each stdout line is emitted as a "text" event.
 * No structured usage data is available from the CLI output.
 */
export class CodexDriver implements AgentDriver {
  readonly name = "codex";

  resolveBinary(): string {
    const dirs = (process.env.PATH ?? "").split(":");
    for (const dir of dirs) {
      const p = `${dir}/codex`;
      if (existsSync(p)) return p;
    }
    const fallbacks = [
      `${process.env.HOME}/.npm-global/bin/codex`,
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "/usr/bin/codex",
      // Rust binary installed via cargo
      `${process.env.HOME}/.cargo/bin/codex`,
    ];
    for (const p of fallbacks) {
      if (existsSync(p)) return p;
    }
    return "codex";
  }

  hasSession(_cwd: string): boolean {
    return false; // no persistent session support
  }

  spawn(options: SpawnOptions): AgentProcess {
    const bin = this.resolveBinary();
    const model = options.model ?? "gpt-4.1";

    const args = [
      "exec",
      options.task,
      "--model", model,
      "--full-auto",
    ];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(options.env ?? {}),
    };

    // Map token → OPENAI_API_KEY
    const apiKey = options.token ?? process.env.OPENAI_API_KEY;
    if (apiKey) env.OPENAI_API_KEY = apiKey;

    let killed = false;
    const emitter = new BaseAgentProcess();

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      process.nextTick(() => {
        emitter.emit("text", `[codex] Failed to spawn: ${String(err)}\nInstall with: npm install -g @openai/codex`);
        emitter.emit("exit", 1);
      });
      emitter.kill = () => { killed = true; };
      return emitter;
    }

    emitter.pid = proc.pid;

    let buffer = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) emitter.emit("text", line);
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s) emitter.emit("text", `[codex stderr] ${s}`);
    });

    proc.on("error", (err) => {
      if (!killed) {
        emitter.emit("text", `[codex] Error: ${err.message}\nInstall with: npm install -g @openai/codex`);
        emitter.emit("exit", 1);
      }
    });

    proc.on("exit", (code) => {
      if (buffer.trim()) emitter.emit("text", buffer.trim());
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
    const pricing = getPricing(model ?? "gpt-4.1");
    const cost =
      (usage.inputTokens * pricing.inputPer1M +
        usage.outputTokens * pricing.outputPer1M) /
      1_000_000;
    return Math.round(cost * 10000) / 10000;
  }
}
