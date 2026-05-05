import { existsSync } from "fs";
import { ClaudeCodeDriver } from "./claude-code.js";
import { AiderDriver } from "./aider.js";
import { OpenAICompatibleDriver } from "./openai-compatible.js";
import { GeminiDriver } from "./gemini.js";
import { AmpDriver } from "./amp.js";
import { CodexDriver } from "./codex.js";
import type { AgentDriver } from "./types.js";

export { ClaudeCodeDriver } from "./claude-code.js";
export { AiderDriver } from "./aider.js";
export { OpenAICompatibleDriver } from "./openai-compatible.js";
export { GeminiDriver } from "./gemini.js";
export { AmpDriver } from "./amp.js";
export { CodexDriver } from "./codex.js";
export type { AgentDriver, AgentProcess, SpawnOptions, UsageEvent, AgentPricing } from "./types.js";
export { getPricing } from "./pricing.js";

const VALID_DRIVERS = ["claude", "claude-code", "aider", "openai", "openai-compatible", "qwen", "kimi", "deepseek", "pi", "gemini", "amp", "codex"] as const;
export type DriverName = typeof VALID_DRIVERS[number];

/**
 * Return an AgentDriver instance for the given name.
 * Throws a descriptive error for unknown names.
 */
export function getDriver(name: string): AgentDriver {
  switch (name) {
    case "claude":
    case "claude-code":
      return new ClaudeCodeDriver();

    case "aider":
      return new AiderDriver();

    case "openai":
    case "openai-compatible":
    case "qwen":
    case "kimi":
    case "deepseek":
    case "pi":
      return new OpenAICompatibleDriver(name);

    case "gemini":
      return new GeminiDriver();

    case "amp":
      return new AmpDriver();

    case "codex":
      return new CodexDriver();

    default:
      throw new Error(
        `Unknown agent driver: '${name}'. Valid drivers: ${VALID_DRIVERS.join(", ")}`
      );
  }
}

/** Return the list of valid driver names. */
export function listDrivers(): string[] {
  return [...VALID_DRIVERS];
}

/**
 * Return status info for each driver (whether the binary / API key is available).
 */
export function getDriverStatus(): Array<{ name: string; available: boolean; note: string }> {
  const drivers: Array<{ name: string; available: boolean; note: string }> = [];

  // Claude Code
  {
    const d = new ClaudeCodeDriver();
    const bin = d.resolveBinary?.() ?? "claude";
    const hasToken =
      !!(process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.CLAUDE_CODE_TOKEN);
    const hasBin = existsSync(bin);
    drivers.push({
      name: "claude",
      available: hasBin,
      note: hasBin
        ? hasToken ? "binary found, token configured" : "binary found (no token — uses ~/.claude auth)"
        : `binary not found at: ${bin}`,
    });
  }

  // Aider
  {
    const d = new AiderDriver();
    const bin = d.resolveBinary?.() ?? "aider";
    const hasBin = existsSync(bin);
    drivers.push({
      name: "aider",
      available: hasBin,
      note: hasBin ? "binary found" : `aider not installed — run: pip install aider-install && aider-install`,
    });
  }

  // OpenAI-compatible drivers
  const apiDrivers: Array<{ name: string; envKey: string }> = [
    { name: "openai",   envKey: "OPENAI_API_KEY" },
    { name: "qwen",     envKey: "QWEN_API_KEY" },
    { name: "kimi",     envKey: "KIMI_API_KEY" },
    { name: "deepseek", envKey: "DEEPSEEK_API_KEY" },
    { name: "pi",       envKey: "PI_API_KEY" },
  ];
  for (const { name, envKey } of apiDrivers) {
    const hasKey = !!(process.env[envKey] ?? process.env.OPENAI_API_KEY);
    drivers.push({
      name,
      available: hasKey,
      note: hasKey ? `${envKey} configured` : `set ${envKey} or OPENAI_API_KEY to enable`,
    });
  }

  // Gemini CLI
  {
    const d = new GeminiDriver();
    const bin = d.resolveBinary?.() ?? "gemini";
    const hasBin = existsSync(bin);
    const hasKey = !!(process.env.GEMINI_API_KEY);
    drivers.push({
      name: "gemini",
      available: hasBin,
      note: hasBin
        ? hasKey ? "binary found, GEMINI_API_KEY configured" : "binary found (no GEMINI_API_KEY — set it to enable)"
        : "gemini not installed — run: npm install -g @google/gemini-cli",
    });
  }

  // Amp CLI
  {
    const d = new AmpDriver();
    const bin = d.resolveBinary?.() ?? "amp";
    const hasBin = existsSync(bin);
    const hasKey = !!(process.env.AMP_API_KEY);
    drivers.push({
      name: "amp",
      available: hasBin,
      note: hasBin
        ? hasKey ? "binary found, AMP_API_KEY configured" : "binary found (no AMP_API_KEY — set it to enable)"
        : "amp not installed — run: npm install -g @sourcegraph/amp",
    });
  }

  // Codex CLI
  {
    const d = new CodexDriver();
    const bin = d.resolveBinary?.() ?? "codex";
    const hasBin = existsSync(bin);
    const hasKey = !!(process.env.OPENAI_API_KEY);
    drivers.push({
      name: "codex",
      available: hasBin,
      note: hasBin
        ? hasKey ? "binary found, OPENAI_API_KEY configured" : "binary found (no OPENAI_API_KEY — set it to enable)"
        : "codex not installed — run: npm install -g @openai/codex",
    });
  }

  return drivers;
}
