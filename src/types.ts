import type { Writable } from "stream";

export type JobStatus = "pending" | "cloning" | "running" | "done" | "failed" | "cancelled" | "sleeping";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface Job {
  id: string;
  repoUrl: string;
  task: string;
  branch?: string;
  createBranch?: string;
  status: JobStatus;
  output: string[];
  toolCalls: string[];
  exitCode?: number;
  error?: string;
  workDir?: string;
  startedAt: Date;
  finishedAt?: Date;
  pid?: number;
  stdinStream?: Writable | null;
  continueSession?: boolean;
  maxBudgetUsd?: number;
  sessionId?: string;
  sessionIdAfter?: string;
  usage?: TokenUsage;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  costUsd?: number;
  dependsOn?: string[];
  claudeToken?: string;
  preamble?: string;
  sleepUntil?: string;    // ISO timestamp — set when status is "sleeping"
  sleepReason?: string;   // text snippet that triggered the sleep
  model?: string;
  ollamaModel?: string;
  ollamaHost?: string;
}

export interface SpawnOptions {
  repoUrl: string;
  task: string;
  branch?: string;
  createBranch?: string;
  claudeToken?: string;
  continueSession?: boolean;
  maxBudgetUsd?: number;
  sessionId?: string;
  dependsOn?: string[];
  preamble?: string;
  model?: string;
  ollamaModel?: string;
  ollamaHost?: string;
}

export interface JobSummary {
  id: string;
  status: JobStatus;
  repoUrl: string;
  task: string;
  branch?: string;
  createBranch?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  recentTools?: string[];
  sessionIdAfter?: string;
  costUsd?: number;
  usage?: TokenUsage;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  sleepUntil?: string;
  sleepReason?: string;
}
