import type { Writable } from "stream";

export type JobStatus = "pending" | "cloning" | "running" | "done" | "failed" | "cancelled" | "sleeping" | "pending_approval" | "rejected" | "interrupted" | "loop_exhausted" | "loop_stalled";

export interface GateFailure {
  gate: "completion" | "reality" | "quality";
  reason: string;
  iteration: number;
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "auto";

export interface CoordinatorPlan {
  next_step?: {
    repo_url: string;
    task: string;
  };
  summary?: string;
}

export interface JobEvent {
  jobId: string;
  status: string;
  title: string;
  repoUrl: string;
  lastLines: string[];   // last 5 lines from job output
  score?: number;
  timestamp: string;     // ISO 8601 date string
  coordinatorPlan?: CoordinatorPlan;
  spawningNamespace?: string; // namespace of the caller that spawned this job
  cronId?: string;        // set when this job was spawned by a cron trigger
  chatId?: number;        // Discord/Telegram chat ID for notification routing
}

export interface OnComplete {
  repo_url: string;
  task: string;
  branch?: string;
}

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
  cronId?: string;        // set when this job was spawned by a cron trigger
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
  interruptedAt?: Date;        // set when status transitions to "interrupted"
  smokeTest?: string;          // shell command to run as cheap pre-check before full task
  smokeTestTimeout?: number;   // smoke test timeout in seconds (default 60)
  variantIndex?: number;       // which variant (1, 2, 3) this job is
  parentVariant?: string;      // job ID of the winning parent variant
  siblings?: string[];         // job IDs of parallel variants (for variant jobs)
  dockerIsolation?: boolean;   // run agent in an isolated Docker container
  resumedFrom?: string;        // job ID this was auto-spawned to resume after interruption
  tokenIndex?: number;         // which token index was active when job ran
  onComplete?: OnComplete;     // spawn a follow-up job when this one finishes with status=done
  agentDriver?: string;        // which driver to use (default: 'claude')
  agentModel?: string;         // model override passed to the driver
  openaiBaseUrl?: string;      // base URL for OpenAI-compatible drivers
  openaiApiKey?: string;       // API key override for OpenAI-compatible drivers
  noPreamble?: boolean;        // if true, no preamble injected — raw task passed directly
  retryCount?: number;         // auto-retry counter (max 1 context-overflow retry)
  timeoutMinutes?: number;     // wall-clock timeout in minutes (0 = disabled, default 120)
  timedOut?: boolean;          // true if job was killed due to timeout
  failReason?: string;         // machine-readable failure reason: 'timeout' | 'budget_exceeded'
  effortLevel?: EffortLevel;   // /effort command level: low|medium|high|xhigh|max|auto
  fastMode?: boolean;          // if true, prepend /fast command at session start
  spawningNamespace?: string;  // namespace of the caller that spawned this job (for notification routing)
  chatId?: number;             // Discord/Telegram chat ID to route completion notification back
  // LoopJob fields
  goal?: string;               // verifiable intent — what "done" looks like
  completionCriteria?: string[]; // deterministic shell checks run after worker finishes
  qualityRubric?: string;      // prompt injected into quality eval agent
  maxIterations?: number;      // hard cap on loop iterations (default 3, max 3)
  iteration?: number;          // current loop iteration, starting at 1
  evalAgentId?: string;        // job ID of the most recent quality eval agent
  gateFailures?: GateFailure[]; // full trace of gate failures across iterations
  loopOutputHash?: string;     // sha256 of last iteration's output (for stall detection)
}

export interface SpawnOptions {
  repoUrl: string;
  task: string;
  branch?: string;
  createBranch?: string;
  cronId?: string;        // set when this job is spawned by a cron trigger
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
  requiresDocker?: boolean;
  resumedFrom?: string;
  onComplete?: OnComplete;     // spawn a follow-up job when this one finishes with status=done
  agentDriver?: string;        // which driver to use (default: 'claude')
  agentModel?: string;         // model override passed to the driver
  openaiBaseUrl?: string;      // base URL for OpenAI-compatible drivers
  openaiApiKey?: string;       // API key override for OpenAI-compatible drivers
  noPreamble?: boolean;        // if true, no preamble injected — raw task passed directly
  timeoutMinutes?: number;     // wall-clock timeout in minutes per run() invocation (0 = disabled, default 120)
  effortLevel?: EffortLevel;   // /effort command level: low|medium|high|xhigh|max|auto
  fastMode?: boolean;          // if true, prepend /fast command at session start
  spawningNamespace?: string;  // namespace of the caller (routes completion notification back to caller)
  chatId?: number;             // Discord/Telegram chat ID to route completion notification back
  // LoopJob fields
  goal?: string;               // verifiable intent — what "done" looks like
  completionCriteria?: string[]; // deterministic shell checks run after worker finishes
  qualityRubric?: string;      // prompt injected into quality eval agent
  maxIterations?: number;      // hard cap on loop iterations (default 3, max 3)
}

// ─── Workflow types ───────────────────────────────────────────────────────────

export type WorkflowStatus = "spawning" | "running" | "done" | "failed" | "partial";

export interface WorkflowStep {
  id: string;
  task: string;
  job_id?: string;
  depends_on?: string[];
}

export interface WorkflowStage {
  stage: number;
  steps: WorkflowStep[];
}

export interface WorkflowRecord {
  workflow_id: string;
  goal: string;
  repo_url: string;
  stages: WorkflowStage[];
  all_job_ids: string[];
  status: WorkflowStatus;
  created_at: string;
  completed_at?: string;
  error?: string;
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
  effortLevel?: EffortLevel;
  fastMode?: boolean;
}
