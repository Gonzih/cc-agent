/**
 * LoopEngine — three-gate completion/reality/quality pipeline for per-job loop control flow.
 *
 * Opt-in: spawn a job with `completionCriteria` set. After each successful worker run the
 * gates execute in order. All gates pass → job is done. Any gate fails → increment iteration,
 * inject structured feedback, re-spawn worker. Hard cap: maxIterations (default 3, max 3).
 *
 * Gate order:
 *   1. Completion gate  — deterministic shell commands in workDir. Binary pass/fail.
 *   2. Reality gate     — skipped gracefully when no command defined (always passes today).
 *   3. Quality gate     — LLM eval agent spawned separately from the worker. Returns JSON.
 */

import { execFile } from "child_process";
import { createHash } from "crypto";
import { promisify } from "util";
import type { Job, GateFailure } from "./types.js";
import type { JobManager } from "./agent.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

export const LOOP_MAX_ITERATIONS = 3;
const QUALITY_GATE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const QUALITY_GATE_POLL_MS = 3000;
const GATE_CMD_TIMEOUT_MS = 60_000;

// ─── Gate results ────────────────────────────────────────────────────────────

export interface GateResult {
  gate: GateFailure["gate"];
  passed: boolean;
  reason?: string;
  feedback?: string;
  confidence?: number;
}

export interface LoopOutcome {
  /** true → caller should re-run the worker with newTask; false → caller should finalize */
  rerun: boolean;
  /** status to set on the job when rerun=false (undefined = keep "done") */
  overrideStatus?: "loop_exhausted" | "loop_stalled";
  /** new task string for next iteration (only set when rerun=true) */
  newTask?: string;
  /** accumulated gate failures */
  gateFailures: GateFailure[];
}

// ─── Completion gate ─────────────────────────────────────────────────────────

/**
 * Run each criterion shell command in workDir.
 * First non-zero exit immediately fails the gate.
 */
export async function runCompletionGate(
  criteria: string[],
  workDir: string,
): Promise<GateResult> {
  for (const cmd of criteria) {
    try {
      await execFileAsync("sh", ["-c", cmd], {
        cwd: workDir,
        timeout: GATE_CMD_TIMEOUT_MS,
      });
    } catch (err: any) {
      const out = [String(err.stdout ?? ""), String(err.stderr ?? "")]
        .filter(Boolean)
        .join(" ")
        .trim()
        .slice(0, 500);
      const reason = err.killed
        ? `timed out after ${GATE_CMD_TIMEOUT_MS / 1000}s: ${cmd}`
        : `${cmd}: ${out || String(err.message ?? err)}`;
      return { gate: "completion", passed: false, reason };
    }
  }
  return { gate: "completion", passed: true };
}

// ─── Reality gate ─────────────────────────────────────────────────────────────

/**
 * Reality gate: run a single check command when defined.
 * Currently skipped gracefully when no command is configured.
 */
export async function runRealityGate(
  checkCmd: string | undefined,
  workDir: string,
): Promise<GateResult> {
  if (!checkCmd) return { gate: "reality", passed: true };
  try {
    await execFileAsync("sh", ["-c", checkCmd], {
      cwd: workDir,
      timeout: GATE_CMD_TIMEOUT_MS,
    });
    return { gate: "reality", passed: true };
  } catch (err: any) {
    const out = [String(err.stdout ?? ""), String(err.stderr ?? "")]
      .filter(Boolean)
      .join(" ")
      .trim()
      .slice(0, 500);
    return {
      gate: "reality",
      passed: false,
      reason: err.killed
        ? `reality check timed out: ${checkCmd}`
        : `reality check failed: ${out || String(err.message ?? err)}`,
    };
  }
}

// ─── Quality gate ─────────────────────────────────────────────────────────────

/**
 * Build the eval agent task. The eval agent is required to output a structured
 * `GATE_EVAL: {...}` line that this engine parses.
 */
export function buildQualityEvalTask(opts: {
  goal: string;
  completionCriteria: string[];
  qualityRubric: string;
  workerOutputSnippet: string;
  workerJobId: string;
  iteration: number;
}): string {
  const criteriaList = opts.completionCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
  return `You are a quality evaluator for an automated agent loop (iteration ${opts.iteration}).

## Original Goal

${opts.goal}

## Completion Criteria

${criteriaList}

## Quality Rubric

${opts.qualityRubric}

## Worker Output (last 100 lines from job ${opts.workerJobId})

\`\`\`
${opts.workerOutputSnippet}
\`\`\`

## Your Task

Evaluate whether the worker's output satisfies the original goal and quality rubric.
Be specific and critical. Do NOT say "try harder" — identify EXACTLY what is missing or wrong.

If the work passes, set passed=true with brief feedback.
If the work fails, set passed=false with SPECIFIC feedback: what exactly is missing, broken, or incorrect.
Set confidence from 0.0 to 1.0 based on how certain you are.

Output EXACTLY this line (and nothing else after it):

GATE_EVAL: {"gate":"quality","passed":<true|false>,"feedback":"<specific actionable feedback>","confidence":<0.0-1.0>}
`;
}

/** Parse the GATE_EVAL JSON line from eval agent output. */
export function parseEvalOutput(lines: string[]): {
  passed: boolean;
  feedback: string;
  confidence: number;
} | null {
  for (const line of [...lines].reverse()) {
    const m = line.match(/GATE_EVAL:\s*(\{.+\})/);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[1]) as { passed: boolean; feedback: string; confidence: number };
      if (typeof obj.passed !== "boolean") continue;
      return {
        passed: obj.passed,
        feedback: String(obj.feedback ?? ""),
        confidence: typeof obj.confidence === "number" ? Math.min(1, Math.max(0, obj.confidence)) : 0.5,
      };
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Spawn a quality eval agent (separate from the worker) and wait for completion.
 * Returns the gate result regardless of whether the eval agent succeeds.
 */
export async function runQualityGate(opts: {
  job: Job;
  manager: JobManager;
  workerOutputLines: string[];
}): Promise<GateResult> {
  const { job, manager, workerOutputLines } = opts;

  if (!job.qualityRubric) return { gate: "quality", passed: true };

  const goal = job.goal ?? job.task.split("\n")[0].trim().slice(0, 300);
  const criteria = job.completionCriteria ?? [];
  const snippet = workerOutputLines.slice(-100).join("\n");

  const evalTask = buildQualityEvalTask({
    goal,
    completionCriteria: criteria,
    qualityRubric: job.qualityRubric,
    workerOutputSnippet: snippet,
    workerJobId: job.id,
    iteration: job.iteration ?? 1,
  });

  let evalJobId: string;
  try {
    evalJobId = await manager.spawn({
      repoUrl: job.repoUrl,
      task: evalTask,
      noPreamble: true,
      effortLevel: "medium",
      maxBudgetUsd: 2,
      spawningNamespace: job.spawningNamespace,
    });
    // Store eval agent ID on the job for visibility
    job.evalAgentId = evalJobId;
    logger.info("[loop] quality-gate-spawned", { jobId: job.id, evalJobId, iteration: job.iteration });
  } catch (err) {
    logger.warn("[loop] quality-gate-spawn-failed", { jobId: job.id, err: String(err) });
    return { gate: "quality", passed: true }; // fail open — don't block on spawn error
  }

  // Poll for completion
  const deadline = Date.now() + QUALITY_GATE_TIMEOUT_MS;
  const TERMINAL = new Set(["done", "failed", "cancelled", "rejected", "interrupted"]);

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, QUALITY_GATE_POLL_MS));
    const evalJob = manager.getJob(evalJobId);
    if (!evalJob) break;
    if (TERMINAL.has(evalJob.status)) {
      const result = parseEvalOutput(evalJob.output);
      if (!result) {
        logger.warn("[loop] quality-gate-no-output", { jobId: job.id, evalJobId });
        return { gate: "quality", passed: true }; // fail open if eval didn't produce output
      }
      logger.info("[loop] quality-gate-result", { jobId: job.id, evalJobId, ...result });
      return {
        gate: "quality",
        passed: result.passed,
        reason: result.passed ? undefined : result.feedback,
        feedback: result.feedback,
        confidence: result.confidence,
      };
    }
  }

  logger.warn("[loop] quality-gate-timeout", { jobId: job.id, evalJobId });
  manager.cancel(evalJobId);
  return { gate: "quality", passed: true }; // timeout → fail open
}

// ─── Output hash ─────────────────────────────────────────────────────────────

/** Compute a fingerprint of the last N output lines for stall detection. */
export function computeOutputHash(outputLines: string[]): string {
  const text = outputLines.slice(-50).join("\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Run the three-gate pipeline for a completed loop job.
 * Returns a LoopOutcome describing what the caller should do next.
 *
 * Must only be called when job.completionCriteria?.length is truthy.
 */
export async function runLoopGates(opts: {
  job: Job;
  manager: JobManager;
  workDir: string;
}): Promise<LoopOutcome> {
  const { job, manager, workDir } = opts;
  const iteration = job.iteration ?? 1;
  const maxIter = Math.min(job.maxIterations ?? LOOP_MAX_ITERATIONS, LOOP_MAX_ITERATIONS);
  const accumulatedFailures: GateFailure[] = [...(job.gateFailures ?? [])];

  // ── Stall detection ──────────────────────────────────────────────────────
  const currentHash = computeOutputHash(job.output);
  if (job.loopOutputHash && job.loopOutputHash === currentHash && iteration > 1) {
    logger.warn("[loop] stalled", { jobId: job.id, iteration, hash: currentHash });
    return {
      rerun: false,
      overrideStatus: "loop_stalled",
      gateFailures: accumulatedFailures,
    };
  }
  job.loopOutputHash = currentHash;

  // ── Gate 1: Completion ────────────────────────────────────────────────────
  const completionResult = await runCompletionGate(
    job.completionCriteria ?? [],
    workDir,
  );
  logger.info("[loop] completion-gate", { jobId: job.id, iteration, passed: completionResult.passed });

  if (!completionResult.passed) {
    const failure: GateFailure = {
      gate: "completion",
      reason: completionResult.reason ?? "unknown",
      iteration,
    };
    accumulatedFailures.push(failure);
    return buildRerunOrExhaust({ job, iteration, maxIter, failure, accumulatedFailures });
  }

  // ── Gate 2: Reality ────────────────────────────────────────────────────────
  const realityResult = await runRealityGate(undefined, workDir);
  logger.info("[loop] reality-gate", { jobId: job.id, iteration, passed: realityResult.passed });

  if (!realityResult.passed) {
    const failure: GateFailure = {
      gate: "reality",
      reason: realityResult.reason ?? "unknown",
      iteration,
    };
    accumulatedFailures.push(failure);
    return buildRerunOrExhaust({ job, iteration, maxIter, failure, accumulatedFailures });
  }

  // ── Gate 3: Quality ────────────────────────────────────────────────────────
  const qualityResult = await runQualityGate({ job, manager, workerOutputLines: job.output });
  logger.info("[loop] quality-gate", { jobId: job.id, iteration, passed: qualityResult.passed });

  if (!qualityResult.passed) {
    const failure: GateFailure = {
      gate: "quality",
      reason: qualityResult.feedback ?? qualityResult.reason ?? "quality gate failed",
      iteration,
    };
    accumulatedFailures.push(failure);
    return buildRerunOrExhaust({ job, iteration, maxIter, failure, accumulatedFailures });
  }

  // ── All gates passed ──────────────────────────────────────────────────────
  logger.info("[loop] all-gates-passed", { jobId: job.id, iteration });
  return { rerun: false, gateFailures: accumulatedFailures };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildRerunOrExhaust(opts: {
  job: Job;
  iteration: number;
  maxIter: number;
  failure: GateFailure;
  accumulatedFailures: GateFailure[];
}): LoopOutcome {
  const { job, iteration, maxIter, failure, accumulatedFailures } = opts;

  if (iteration >= maxIter) {
    logger.warn("[loop] exhausted", { jobId: job.id, iteration, gate: failure.gate });
    return {
      rerun: false,
      overrideStatus: "loop_exhausted",
      gateFailures: accumulatedFailures,
    };
  }

  // Build augmented task: original goal + gate feedback
  const feedbackSection = buildFeedbackSection(accumulatedFailures);
  const newTask = appendFeedbackToTask(job.task, feedbackSection);

  return {
    rerun: true,
    newTask,
    gateFailures: accumulatedFailures,
  };
}

function buildFeedbackSection(failures: GateFailure[]): string {
  if (!failures.length) return "";
  const lines = [
    "## Gate Feedback from Previous Iterations",
    "",
    "The following issues were detected and must be fixed in this attempt:",
    "",
    ...failures.map((f, i) =>
      `### Issue ${i + 1} (iteration ${f.iteration}, ${f.gate} gate)\n${f.reason}`
    ),
    "",
  ];
  return lines.join("\n");
}

function appendFeedbackToTask(originalTask: string, feedback: string): string {
  return `${originalTask}\n\n${feedback}`.trimEnd();
}
