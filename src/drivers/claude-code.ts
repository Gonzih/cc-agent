import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { runClaude, resolveClaude } from "../claude.js";
import { getPricing } from "./pricing.js";
import { BaseAgentProcess } from "./types.js";
import type { AgentDriver, AgentProcess, SpawnOptions, UsageEvent } from "./types.js";

/**
 * ClaudeCodeDriver wraps the existing runClaude() function from claude.ts.
 * All session management, binary resolution, and stream-json parsing is
 * delegated to the existing implementation — behaviour is byte-for-byte identical.
 */
export class ClaudeCodeDriver implements AgentDriver {
  readonly name = "claude";

  resolveBinary(): string {
    return resolveClaude();
  }

  hasSession(cwd: string): boolean {
    // Claude stores sessions under ~/.claude/projects/<encoded-cwd>/
    // Path encoding: leading slash stripped, remaining slashes → dashes
    const projectsDir = join(homedir(), ".claude", "projects");
    if (!existsSync(projectsDir)) return false;
    try {
      // Claude Code encodes the path by stripping the leading '/' and replacing all '/' with '-'
      const encoded = cwd.replace(/^\//, "").replace(/\//g, "-");
      if (existsSync(join(projectsDir, encoded))) return true;
      // Some versions prefix with a leading dash
      if (existsSync(join(projectsDir, `-${encoded}`))) return true;
    } catch {
      // ignore
    }
    return false;
  }

  spawn(options: SpawnOptions): AgentProcess {
    // Extract ollama config encoded in env by agent.ts
    const ollamaModel = options.env?.CC_DRIVER_OLLAMA_MODEL;
    const ollamaHost = options.env?.CC_DRIVER_OLLAMA_HOST;

    const proc = runClaude(options.task, options.cwd, options.token, {
      continueSession: options.continueSession,
      maxBudgetUsd: options.budgetUsd,
      sessionId: options.sessionId,
      model: options.model,
      ollamaModel,
      ollamaHost,
    });

    // Adapt OneShot interface → AgentProcess interface
    // Main difference: "session" event → "sessionId" event
    const emitter = new BaseAgentProcess();

    proc.on("text", (text: string) => emitter.emit("text", text));
    proc.on("tool", (name: string) => emitter.emit("tool", name));
    proc.on("usage", (u: UsageEvent) => emitter.emit("usage", u));
    proc.on("session", (id: string) => emitter.emit("sessionId", id));
    proc.on("error", (err: Error) => {
      // Translate error events into a non-zero exit so agent.ts sees a failure
      emitter.emit("text", `[cc-agent] Claude error: ${err.message}`);
      emitter.emit("exit", 1);
    });
    proc.on("exit", (code: number | null) => emitter.emit("exit", code));

    emitter.pid = proc.pid;

    emitter.kill = (signal?: string) => {
      void signal; // ClaudeCodeDriver always SIGTERMs the process group
      proc.kill();
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
    const pricing = getPricing(model ?? "claude-sonnet-4-6");
    const cost =
      (usage.inputTokens * pricing.inputPer1M +
        usage.outputTokens * pricing.outputPer1M +
        (usage.cacheReadTokens ?? 0) * (pricing.cacheReadPer1M ?? 0) +
        (usage.cacheWriteTokens ?? 0) * (pricing.cacheWritePer1M ?? 0)) /
      1_000_000;
    return Math.round(cost * 10000) / 10000;
  }
}
