import type { Writable } from "stream";

export type JobStatus = "pending" | "cloning" | "running" | "done" | "failed" | "cancelled";

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
}
