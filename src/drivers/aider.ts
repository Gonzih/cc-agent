import { existsSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { getPricing } from "./pricing.js";
import { BaseAgentProcess } from "./types.js";
import type { AgentDriver, AgentProcess, SpawnOptions, UsageEvent } from "./types.js";

/**
 * AiderDriver wraps the `aider` CLI (https://github.com/paul-gauthier/aider).
 * Spawns: aider --message "<task>" --yes --no-pretty --no-stream --model <model>
 */
export class AiderDriver implements AgentDriver {
  readonly name = "aider";

  resolveBinary(): string {
    const dirs = (process.env.PATH ?? "").split(":");
    for (const dir of dirs) {
      const p = `${dir}/aider`;
      if (existsSync(p)) return p;
    }
    const fallbacks = [
      "/opt/homebrew/bin/aider",
      "/usr/local/bin/aider",
      "/usr/bin/aider",
      `${process.env.HOME}/.local/bin/aider`,
    ];
    for (const p of fallbacks) {
      if (existsSync(p)) return p;
    }
    return "aider";
  }

  hasSession(cwd: string): boolean {
    return existsSync(join(cwd, ".aider.chat.history.md"));
  }

  spawn(options: SpawnOptions): AgentProcess {
    const bin = this.resolveBinary();
    const model = options.model ?? "gpt-4o";

    const args = [
      "--message", options.task,
      "--yes",
      "--no-pretty",
      "--no-stream",
      "--model", model,
    ];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(options.env ?? {}),
    };

    // Map token to OPENAI_API_KEY if it looks like an OpenAI key
    if (options.token && options.token.startsWith("sk-")) {
      env.OPENAI_API_KEY = options.token;
    }

    let killed = false;
    const emitter = new BaseAgentProcess();

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      process.nextTick(() => {
        emitter.emit("text", `[aider] Failed to spawn: ${String(err)}\nInstall with: pip install aider-install && aider-install`);
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
      if (s) emitter.emit("text", `[aider stderr] ${s}`);
    });

    proc.on("error", (err) => {
      if (!killed) {
        emitter.emit("text", `[aider] Error: ${err.message}\nInstall with: pip install aider-install && aider-install`);
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
    const pricing = getPricing(model ?? "gpt-4o");
    const cost =
      (usage.inputTokens * pricing.inputPer1M +
        usage.outputTokens * pricing.outputPer1M) /
      1_000_000;
    return Math.round(cost * 10000) / 10000;
  }
}
