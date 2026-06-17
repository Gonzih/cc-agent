import { EventEmitter } from "events";

export interface SpawnOptions {
  cwd: string;
  task: string;
  budgetUsd: number;
  token?: string;
  continueSession?: boolean;
  sessionId?: string;
  model?: string;
  jobId?: string;    // used for deterministic log file naming
  /** Additional env vars merged over process.env before spawning. */
  env?: Record<string, string>;
}

export interface UsageEvent {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface AgentProcess {
  pid?: number;
  on(event: "text", handler: (chunk: string) => void): this;
  on(event: "tool", handler: (name: string) => void): this;
  on(event: "usage", handler: (u: UsageEvent) => void): this;
  on(event: "sessionId", handler: (id: string) => void): this;
  on(event: "exit", handler: (code: number | null) => void): this;
  on(event: string, handler: (...args: unknown[]) => void): this;
  kill(signal?: string): void;
  writeStdin?(data: string): void;
}

export interface AgentDriver {
  readonly name: string;
  resolveBinary?(): string;
  hasSession(cwd: string): boolean;
  spawn(options: SpawnOptions): AgentProcess;
  estimateCost(usage: UsageEvent, model?: string): number;
}

export interface AgentPricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

/**
 * Concrete base class for AgentProcess implementations.
 * Extends EventEmitter so drivers can call .emit() and
 * satisfies the AgentProcess interface by declaring all required members.
 */
export class BaseAgentProcess extends EventEmitter implements AgentProcess {
  pid?: number;
  writeStdin?: (data: string) => void;

  /** Implementations must override this. Default is a no-op. */
  kill(_signal?: string): void {}
}
