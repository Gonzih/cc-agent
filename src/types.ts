import type { Writable } from "stream";

export type JobStatus = "pending" | "cloning" | "running" | "done" | "failed" | "cancelled" | "sleeping" | "pending_approval" | "rejected" | "interrupted";

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
  sleepUntil?: string;         // ISO timestamp — set when status is "sleeping"
  sleepReason?: string;        // text snippet that triggered the sleep
  model?: string;
  ollamaModel?: string;
  ollamaHost?: string;
  approvalIssueUrl?: string;   // GitHub issue URL for pending_approval jobs
  approvalRepo?: string;       // "owner/repo" for polling
  approvalIssueNumber?: number; // issue number for polling
  score?: number | null;       // 0.0 to 1.0, set by evaluator, agent, or heuristic
  scoreSource?: "self_reported" | "heuristic" | null;
  smokeTest?: string;          // shell command to run as cheap pre-check before full task
  smokeTestTimeout?: number;   // smoke test timeout in seconds (default 60)
  variantIndex?: number;       // which variant (1, 2, 3) this job is
  parentVariant?: string;      // job ID of the winning parent variant
  siblings?: string[];         // job IDs of parallel variants (for variant jobs)
  dockerIsolation?: boolean;   // run agent in an isolated Docker container
  resumedFrom?: string;        // job ID this was auto-spawned to resume after interruption
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
  requiresApproval?: boolean;
  smokeTest?: string;
  smokeTestTimeout?: number;
  variantIndex?: number;
  parentVariant?: string;
  siblings?: string[];
  dockerIsolation?: boolean;
  resumedFrom?: string;
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
  approvalIssueUrl?: string;
  score?: number | null;
  scoreSource?: "self_reported" | "heuristic" | null;
  variantIndex?: number;
  parentVariant?: string;
  siblings?: string[];
  isolation?: "docker" | "host";
  resumedFrom?: string;
}
