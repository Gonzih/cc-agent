import { execFile } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, rm, appendFile, mkdir } from "fs/promises";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import { runClaude } from "./claude.js";
import { injectPreamble } from "./preamble.js";
import type { Job, JobSummary, SpawnOptions } from "./types.js";
import { ensureStateDirs, isPidAlive } from "./state.js";
import { jobStore, learningsStore, type JobRecord } from "./store.js";
import { getNamespace } from "./namespace.js";
import { logger } from "./logger.js";
import { isDockerAvailable, runDockerAgent, getDockerEnv } from "./docker.js";

const execFileAsync = promisify(execFile);

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour — clean up old done jobs from memory

// Claude Sonnet 4.6 pricing (USD per 1M tokens)
const PRICE_INPUT = 3.00;
const PRICE_OUTPUT = 15.00;
const PRICE_CACHE_READ = 0.30;
const PRICE_CACHE_WRITE = 3.75;

const LIMIT_PATTERNS = [
  /you'?ve hit your (usage )?limit/i,
  /claude ai usage limit reached/i,
  /your (usage|plan) will reset at \d/i,
  /claude\.ai.*has been (rate )?limited/i,
];

function isLimitMessage(text: string): boolean {
  return LIMIT_PATTERNS.some((p) => p.test(text));
}

/** Parse a reset timestamp from limit messages like "resets 2pm (America/Los_Angeles)". */
function parseResetTime(text: string): Date {
  const defaultWake = new Date(Date.now() + 60 * 60 * 1000);
  const match = text.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
  if (!match) return defaultWake;
  try {
    const hourRaw = parseInt(match[1]);
    const min = parseInt(match[2] ?? "0");
    const ampm = match[3].toLowerCase();
    const tz = match[4];
    let h24 = hourRaw % 12;
    if (ampm === "pm") h24 += 12;
    const now = new Date();
    // Represent "now" as a wall-clock Date in the target timezone
    const tzNowStr = now.toLocaleString("en-US", { timeZone: tz });
    const tzNow = new Date(tzNowStr);
    const tzTarget = new Date(tzNowStr);
    tzTarget.setHours(h24, min, 0, 0);
    // If already past today's reset time in that TZ, advance by one day
    if (tzTarget <= tzNow) tzTarget.setDate(tzTarget.getDate() + 1);
    const msUntilReset = tzTarget.getTime() - tzNow.getTime();
    return new Date(now.getTime() + msUntilReset);
  } catch {
    return defaultWake;
  }
}

/** Extract the ## LEARNINGS block from job output lines (everything from that heading to end). */
function extractLearnings(output: string[]): string | null {
  const idx = output.findIndex((line) => /^##\s+LEARNINGS\b/.test(line.trim()));
  if (idx === -1) return null;
  return output.slice(idx).join("\n").trim();
}

/** Build a preamble prefix with prior namespace learnings. */
function buildLearningsPreamble(learnings: string[]): string {
  if (!learnings.length) return "";
  const items = learnings
    .map((l, i) => `### Learning ${i + 1} (most recent first)\n${l}`)
    .join("\n\n");
  return `## Prior Learnings in This Namespace (read before starting)\n${items}\n\n---\n\n`;
}

/** Extract a quality score from job output lines. Exported for testing. */
export function extractScore(output: string[]): { score: number; source: "self_reported" | "heuristic" } {
  // Check for self-reported score
  for (const line of output) {
    const m = line.match(/AGENT_SCORE:\s*(-?[0-9.]+)/);
    if (m) {
      const score = Math.min(1.0, Math.max(0.0, parseFloat(m[1])));
      if (!isNaN(score)) return { score, source: "self_reported" };
    }
  }

  // Heuristic scoring — nothing to detect from empty output
  if (output.length === 0) return { score: 0.5, source: "heuristic" };

  let score = 0;
  const allOutput = output.join("\n");

  // PR merged: +0.4
  if (/pull request.*merged|successfully merged|squash.*merged/i.test(allOutput)) {
    score += 0.4;
  }

  // Tests passing: +0.4 proportional to pass rate
  const testMatch = allOutput.match(/(\d+) passing[^]*?(\d+) failing/);
  if (testMatch) {
    const passing = parseInt(testMatch[1]);
    const failing = parseInt(testMatch[2]);
    const total = passing + failing;
    if (total > 0) score += 0.4 * (passing / total);
  } else if (/\d+ passing/i.test(allOutput) && !/\d+ failing/i.test(allOutput)) {
    score += 0.4;
  }

  // No ERROR or FAILED in last 20 lines: +0.2
  const last20 = output.slice(-20).join("\n");
  if (!/\bERROR\b|\bFAILED\b/.test(last20)) {
    score += 0.2;
  }

  return { score: Math.min(1.0, Math.round(score * 1000) / 1000), source: "heuristic" };
}

function calculateCost(job: Job): number {
  const cost =
    ((job.totalInputTokens ?? 0) * PRICE_INPUT +
      (job.totalOutputTokens ?? 0) * PRICE_OUTPUT +
      (job.totalCacheReadTokens ?? 0) * PRICE_CACHE_READ +
      (job.totalCacheWriteTokens ?? 0) * PRICE_CACHE_WRITE) /
    1_000_000;
  return Math.round(cost * 10000) / 10000;
}

function toRecord(job: Job): JobRecord {
  return {
    id: job.id,
    status: job.status,
    repoUrl: job.repoUrl,
    task: job.task,
    branch: job.branch,
    createBranch: job.createBranch,
    dependsOn: job.dependsOn,
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString(),
    exitCode: job.exitCode,
    error: job.error,
    pid: job.pid,
    sessionIdAfter: job.sessionIdAfter,
    usage: job.usage,
    totalInputTokens: job.totalInputTokens,
    totalOutputTokens: job.totalOutputTokens,
    totalCacheReadTokens: job.totalCacheReadTokens,
    totalCacheWriteTokens: job.totalCacheWriteTokens,
    costUsd: job.costUsd,
    recentTools: job.toolCalls.slice(-10),
    outputLineCount: job.output.length,
    sleepUntil: job.sleepUntil,
    sleepReason: job.sleepReason,
    approvalIssueUrl: job.approvalIssueUrl,
    approvalRepo: job.approvalRepo,
    approvalIssueNumber: job.approvalIssueNumber,
    score: job.score ?? null,
    scoreSource: job.scoreSource ?? null,
    variantIndex: job.variantIndex,
    parentVariant: job.parentVariant,
    siblings: job.siblings,
    dockerIsolation: job.dockerIsolation,
    isolation: job.dockerIsolation ? "docker" : "host",
    resumedFrom: job.resumedFrom,
    interruptedAt: job.interruptedAt?.toISOString(),
  };
}

function fromRecord(r: JobRecord): Job {
  return {
    id: r.id,
    repoUrl: r.repoUrl,
    task: r.task,
    branch: r.branch,
    createBranch: r.createBranch,
    status: r.status,
    output: [],
    toolCalls: r.recentTools ?? [],
    exitCode: r.exitCode,
    error: r.error,
    startedAt: new Date(r.startedAt ?? Date.now()),
    finishedAt: r.finishedAt ? new Date(r.finishedAt) : undefined,
    pid: r.pid,
    sessionIdAfter: r.sessionIdAfter,
    usage: r.usage,
    totalInputTokens: r.totalInputTokens,
    totalOutputTokens: r.totalOutputTokens,
    totalCacheReadTokens: r.totalCacheReadTokens,
    totalCacheWriteTokens: r.totalCacheWriteTokens,
    costUsd: r.costUsd,
    dependsOn: r.dependsOn,
    sleepUntil: r.sleepUntil,
    sleepReason: r.sleepReason,
    approvalIssueUrl: r.approvalIssueUrl,
    approvalRepo: r.approvalRepo,
    approvalIssueNumber: r.approvalIssueNumber,
    score: r.score,
    scoreSource: r.scoreSource,
    variantIndex: r.variantIndex,
    parentVariant: r.parentVariant,
    siblings: r.siblings,
    dockerIsolation: r.dockerIsolation,
    resumedFrom: r.resumedFrom,
    interruptedAt: r.interruptedAt ? new Date(r.interruptedAt) : undefined,
  };
}

const APPROVAL_POLL_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
const APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;  // 24 hours

export class JobManager {
  private jobs = new Map<string, Job>();
  private kills = new Map<string, () => void>();
  private wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private approvalPollers = new Map<string, { intervalId: ReturnType<typeof setInterval>; startTime: number }>();
  private defaultToken?: string;
  /** Jobs restored from storage — their output lives in store, not in job.output[]. */
  private restoredJobs = new Set<string>();
  /** Active Docker container names for cleanup on exit. */
  private activeDockerContainers = new Set<string>();

  constructor(token?: string) {
    this.defaultToken = token;
    ensureStateDirs();
    // Periodic cleanup of old finished jobs
    setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
    // Periodic check for restored running jobs whose PID may have died
    setInterval(() => this.checkRestoredRunning(), 30 * 1000).unref();
    // Dependency scheduler — promote pending jobs when deps are done
    setInterval(() => this.tick(), 3000).unref();
    // Clean up Docker containers on process exit
    const cleanup = () => { void this.cleanupDockerContainers(); };
    process.once("SIGTERM", cleanup);
    process.once("SIGINT", cleanup);
  }

  /** Must be called after initRedis() at startup. */
  async init(): Promise<void> {
    const records = await jobStore.loadAll();
    const updates: Array<JobRecord> = [];
    let orphanCount = 0;

    for (const r of records) {
      let status = r.status;
      let error = r.error;
      let finishedAt = r.finishedAt;
      let interruptedAt = r.interruptedAt;

      if (status === "pending_approval") {
        // pending_approval jobs survive restarts — approval poller is rescheduled below
      } else if (status === "running" || status === "cloning") {
        const isAlive = r.pid ? isPidAlive(r.pid) : false;
        if (!isAlive) {
          status = "interrupted";
          error = (error ? error + "; " : "") + "Process not found after restart";
          finishedAt = finishedAt ?? new Date().toISOString();
          interruptedAt = interruptedAt ?? new Date().toISOString();
          orphanCount++;
        }
        // else: process is alive — keep as running
      }
      // sleeping jobs survive restarts — wake timer is rescheduled below

      const job = fromRecord({ ...r, status, error, finishedAt, interruptedAt });
      this.jobs.set(job.id, job);
      this.restoredJobs.add(job.id);

      if (status !== r.status) {
        updates.push({ ...r, status, error, finishedAt, interruptedAt });
      }
    }

    if (orphanCount > 0) {
      logger.info(`[cc-agent] Detected ${orphanCount} orphaned running jobs from previous session → marked as interrupted`);
    }

    // Persist any status corrections back to store
    for (const updated of updates) {
      jobStore.saveJob(updated).catch(() => {});
    }

    // Re-schedule wake timers for sleeping jobs that survived a restart
    // Re-schedule approval pollers for pending_approval jobs that survived a restart
    for (const [, job] of this.jobs) {
      if (job.status === "sleeping") {
        this.scheduleWake(job);
      } else if (job.status === "pending_approval" && job.approvalRepo && job.approvalIssueNumber) {
        this.scheduleApprovalPoll(job);
      }
    }
  }

  private checkRestoredRunning(): void {
    for (const id of this.restoredJobs) {
      const job = this.jobs.get(id);
      if (!job) continue;
      if (job.status === "sleeping") continue; // managed by wake timer
      if (job.status === "pending_approval") continue; // managed by approval poller
      if (job.status === "running" || job.status === "cloning") {
        if (!job.pid || !isPidAlive(job.pid)) {
          job.status = "interrupted";
          job.finishedAt = new Date();
          job.interruptedAt = job.interruptedAt ?? new Date();
          job.error = (job.error ? job.error + "; " : "") + "Process exited after MCP restart";
          logger.warn("job:process-died", { id, pid: job.pid });
          this.persistJob(job);
          this.addOutput(job, "[cc-agent] Process no longer alive after MCP restart");
        }
      }
    }
  }

  private persistJob(job: Job): void {
    jobStore.saveJob(toRecord(job)).catch(() => {});
  }

  private addOutput(job: Job, line: string): void {
    job.output.push(line);
    jobStore.appendOutput(job.id, line).catch(() => {});
  }

  async spawn(opts: SpawnOptions): Promise<string> {
    // Prepend prior namespace learnings to the task
    const namespace = getNamespace();
    const priorLearnings = await learningsStore.getLearnings(namespace, 5);
    const task = priorLearnings.length
      ? buildLearningsPreamble(priorLearnings) + opts.task
      : opts.task;

    const id = uuidv4();
    const pendingDeps = opts.dependsOn?.filter((depId) => {
      const dep = this.jobs.get(depId);
      return dep?.status !== "done";
    });
    const isPending = pendingDeps && pendingDeps.length > 0;
    const requiresApproval = opts.requiresApproval ?? false;

    let initialStatus: Job["status"];
    if (isPending) initialStatus = "pending";
    else if (requiresApproval) initialStatus = "pending_approval";
    else initialStatus = "cloning";

    const job: Job = {
      id,
      repoUrl: opts.repoUrl,
      task,
      branch: opts.branch,
      createBranch: opts.createBranch,
      continueSession: opts.continueSession,
      maxBudgetUsd: opts.maxBudgetUsd ?? 20,
      sessionId: opts.sessionId,
      claudeToken: opts.claudeToken,
      dependsOn: opts.dependsOn,
      preamble: opts.preamble,
      model: opts.model,
      ollamaModel: opts.ollamaModel,
      ollamaHost: opts.ollamaHost,
      dockerIsolation: opts.dockerIsolation,
      smokeTest: opts.smokeTest,
      smokeTestTimeout: opts.smokeTestTimeout,
      status: initialStatus,
      output: [],
      toolCalls: [],
      startedAt: new Date(),
      variantIndex: opts.variantIndex,
      parentVariant: opts.parentVariant,
      siblings: opts.siblings,
      resumedFrom: opts.resumedFrom,
    };
    this.jobs.set(id, job);
    this.persistJob(job);
    logger.info("job:spawned", { id, status: job.status, repoUrl: opts.repoUrl });

    if (!isPending && !requiresApproval) {
      this.run(job, opts.claudeToken ?? this.defaultToken).catch((err) => {
        job.status = "failed";
        job.error = String(err);
        job.finishedAt = new Date();
        this.persistJob(job);
      });
    }

    return id;
  }

  /** Set approval metadata and start background polling for /approve comments. */
  startApprovalPolling(jobId: string, issueUrl: string, repo: string, issueNumber: number): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "pending_approval") return;
    job.approvalIssueUrl = issueUrl;
    job.approvalRepo = repo;
    job.approvalIssueNumber = issueNumber;
    this.persistJob(job);
    this.scheduleApprovalPoll(job);
  }

  private scheduleApprovalPoll(job: Job): void {
    if (!job.approvalRepo || !job.approvalIssueNumber) return;
    const repo = job.approvalRepo;
    const issueNumber = job.approvalIssueNumber;
    const startTime = Date.now();

    const intervalId = setInterval(async () => {
      if (job.status !== "pending_approval") {
        clearInterval(intervalId);
        this.approvalPollers.delete(job.id);
        return;
      }

      if (Date.now() - startTime > APPROVAL_TIMEOUT_MS) {
        clearInterval(intervalId);
        this.approvalPollers.delete(job.id);
        job.status = "rejected";
        job.finishedAt = new Date();
        job.error = "Approval timed out after 24 hours";
        logger.info("job:approval-timeout", { id: job.id });
        this.addOutput(job, "[cc-agent] Approval timed out after 24 hours. Job rejected.");
        this.persistJob(job);
        return;
      }

      try {
        const { stdout } = await execFileAsync("gh", [
          "issue", "view", String(issueNumber), "--repo", repo, "--json", "comments",
        ]);
        const data = JSON.parse(stdout) as { comments?: Array<{ body: string }> };
        const approved = data.comments?.some((c) => /\/approve\b/i.test(c.body));
        if (approved) {
          clearInterval(intervalId);
          this.approvalPollers.delete(job.id);
          this.doApprove(job);
        }
      } catch {
        // Non-fatal polling failure; try again next interval
      }
    }, APPROVAL_POLL_INTERVAL_MS);

    intervalId.unref();
    this.approvalPollers.set(job.id, { intervalId, startTime });
  }

  private doApprove(job: Job): void {
    logger.info("job:approved", { id: job.id });
    this.addOutput(job, "[cc-agent] Approved. Starting job...");
    this.run(job, job.claudeToken ?? this.defaultToken).catch((err) => {
      job.status = "failed";
      job.error = String(err);
      job.finishedAt = new Date();
      this.persistJob(job);
    });
  }

  async approveJob(id: string): Promise<{ status: string; message: string }> {
    const job = this.jobs.get(id);
    if (!job) return { status: "error", message: "Job not found" };
    if (job.status !== "pending_approval") {
      return { status: "error", message: `Job is not pending approval (status: ${job.status})` };
    }
    const poller = this.approvalPollers.get(id);
    if (poller) {
      clearInterval(poller.intervalId);
      this.approvalPollers.delete(id);
    }
    this.doApprove(job);
    return { status: "ok", message: `Job ${id} approved and starting.` };
  }

  private async run(job: Job, token?: string): Promise<void> {
    // Docker isolation mode: run the entire agent inside a fresh container
    if (job.dockerIsolation) {
      await this.runDockerIsolated(job, token);
      return;
    }

    // If resuming from sleep and the workDir still exists, skip clone/branch.
    const isResume = !!(job.workDir && existsSync(job.workDir));
    let workDir: string | undefined = isResume ? job.workDir : undefined;
    let sleepRequested = false;

    try {
      if (!isResume) {
        // 1. Clone
        workDir = await mkdtemp(join(tmpdir(), `cc-agent-${job.id.slice(0, 8)}-`));
        job.workDir = workDir;
        logger.info("job:cloning", { id: job.id, repoUrl: job.repoUrl });
        this.addOutput(job, `[cc-agent] Cloning ${job.repoUrl}...`);

        const cloneArgs = ["clone", "--depth", "1"];
        // Only checkout an existing branch during clone; if we're creating a new
        // branch it doesn't exist on remote yet, so clone the default branch first.
        if (job.branch && !job.createBranch) cloneArgs.push("--branch", job.branch);
        cloneArgs.push(job.repoUrl, workDir);

        await execFileAsync("git", cloneArgs);
        this.addOutput(job, `[cc-agent] Cloned to ${workDir}`);

        // 2. Create branch if requested
        const branchName = job.createBranch && job.createBranch !== "true" && job.createBranch !== "false"
          ? job.createBranch
          : null;
        if (branchName) {
          await execFileAsync("git", ["checkout", "-b", branchName], { cwd: workDir });
          this.addOutput(job, `[cc-agent] Created branch: ${branchName}`);
        } else if (job.createBranch === "true") {
          const auto = `agent/${job.id.slice(0, 8)}`;
          await execFileAsync("git", ["checkout", "-b", auto], { cwd: workDir });
          this.addOutput(job, `[cc-agent] Created branch: ${auto}`);
        }

        // 3. Smoke test gate (if provided)
        if (job.smokeTest) {
          const timeoutMs = (job.smokeTestTimeout ?? 60) * 1000;
          this.addOutput(job, `[cc-agent] Running smoke test: ${job.smokeTest}`);
          try {
            await execFileAsync("sh", ["-c", job.smokeTest], {
              cwd: workDir,
              timeout: timeoutMs,
            });
            this.addOutput(job, `[cc-agent] Smoke test passed`);
          } catch (smokeErr: any) {
            const combined = (String(smokeErr.stdout ?? "") + String(smokeErr.stderr ?? "")).trim();
            const reason = smokeErr.killed ? "timed out" : (combined.slice(0, 500) || String(smokeErr));
            job.status = "failed";
            job.error = `smoke test failed: ${reason}`;
            job.finishedAt = new Date();
            logger.warn("job:smoke-test-failed", { id: job.id, error: job.error });
            this.addOutput(job, `[cc-agent] Smoke test FAILED: ${job.error}`);
            this.persistJob(job);
            return;
          }
        }
      }

      // 4. Run Claude
      job.status = "running";
      this.persistJob(job);
      logger.info("job:running", { id: job.id, isResume });
      this.addOutput(job, isResume
        ? `[cc-agent] Resuming Claude after sleep...`
        : `[cc-agent] Starting Claude with task...`);

      await new Promise<void>((resolve, reject) => {
        const proc = runClaude(injectPreamble(job.task, job.preamble), workDir!, token, {
          continueSession: isResume || job.continueSession,
          maxBudgetUsd: job.maxBudgetUsd,
          sessionId: job.sessionId,
          model: job.model,
          ollamaModel: job.ollamaModel,
          ollamaHost: job.ollamaHost,
        });

        if (proc.pid != null) {
          job.pid = proc.pid;
          this.persistJob(job);
        }

        this.kills.set(job.id, () => proc.kill());
        job.stdinStream = proc.stdin ?? null;

        proc.on("session", (sid: string) => {
          if (!job.sessionIdAfter) {
            job.sessionIdAfter = sid;
            this.persistJob(job);
          }
        });

        proc.on("usage", (u) => {
          job.totalInputTokens = (job.totalInputTokens ?? 0) + u.inputTokens;
          job.totalOutputTokens = (job.totalOutputTokens ?? 0) + u.outputTokens;
          job.totalCacheReadTokens = (job.totalCacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
          job.totalCacheWriteTokens = (job.totalCacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0);
          job.costUsd = u.costUsd != null ? u.costUsd : calculateCost(job);
          this.persistJob(job);
        });

        proc.on("text", (text) => {
          if (text.trim()) this.addOutput(job, text);
          // Detect usage/rate limit messages and park the job as sleeping
          if (!sleepRequested && job.output.length > 3 && isLimitMessage(text)) {
            sleepRequested = true;
            const wakeAt = parseResetTime(text);
            job.status = "sleeping";
            job.sleepUntil = wakeAt.toISOString();
            job.sleepReason = text.trim().slice(0, 500);
            this.persistJob(job);
            logger.warn("job:sleeping", { id: job.id, sleepUntil: job.sleepUntil, triggeringText: text.trim().slice(0, 500) });
            this.addOutput(job, `[cc-agent] Usage limit detected. Sleeping until ${job.sleepUntil}`);
            proc.kill();
          }
        });

        proc.on("tool", (name: string) => {
          job.toolCalls.push(name);
          if (job.toolCalls.length > 50) job.toolCalls = job.toolCalls.slice(-50);
        });

        proc.on("error", (err) => { reject(err); });

        proc.on("exit", (code) => {
          job.exitCode = code ?? undefined;
          job.stdinStream = null;
          this.kills.delete(job.id);
          // Resolve on sleep (we killed the proc intentionally) or clean exit
          if (sleepRequested || code === 0 || code === null) resolve();
          else reject(new Error(`Claude exited with code ${code}`));
        });
      });

      if (sleepRequested) {
        // Park here — scheduleWake will re-invoke run() when the timer fires
        this.scheduleWake(job);
        return;
      }

      // Score the completed job (if not already manually scored via setJobScore)
      if (job.score == null) {
        const { score, source } = extractScore(job.output);
        job.score = score;
        job.scoreSource = source;
      }

      job.status = "done";
      logger.info("job:done", { id: job.id, exitCode: job.exitCode ?? 0, costUsd: job.costUsd, score: job.score, scoreSource: job.scoreSource });
      this.addOutput(job, `[cc-agent] Done. Exit code: ${job.exitCode ?? 0}`);
      this.persistJob(job);

      // Extract and store learnings for this namespace
      const learnings = extractLearnings(job.output);
      if (learnings) {
        const ns = getNamespace();
        learningsStore.addLearning(ns, learnings).catch(() => {});
        logger.info("job:learnings-extracted", { id: job.id, namespace: ns, length: learnings.length });
      }

      if (job.ollamaModel) {
        this.writeModelRating(job).catch(() => {});
      }
    } catch (err) {
      if (!sleepRequested) {
        if (job.score == null) {
          const { score, source } = extractScore(job.output);
          job.score = score;
          job.scoreSource = source;
        }
        job.status = "failed";
        job.error = String(err);
        logger.error("job:failed", { id: job.id, error: job.error });
        this.addOutput(job, `[cc-agent] FAILED: ${job.error}`);
        this.persistJob(job);
      }
    } finally {
      if (!sleepRequested) {
        job.finishedAt = new Date();
        this.persistJob(job);
        if (workDir) {
          setTimeout(
            () => rm(workDir!, { recursive: true, force: true }).catch(() => {}),
            10 * 60 * 1000
          ).unref();
        }
      }
    }
  }

  private async runDockerIsolated(job: Job, token?: string): Promise<void> {
    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      logger.warn("docker:unavailable — falling back to host mode", { id: job.id });
      this.addOutput(job, "[cc-agent] Docker unavailable — falling back to host mode");
      job.dockerIsolation = false;
      await this.run(job, token);
      return;
    }

    const containerName = `cc-agent-${job.id.slice(0, 8)}`;
    job.status = "running";
    this.persistJob(job);
    logger.info("job:docker-start", { id: job.id, containerName });
    this.addOutput(job, `[cc-agent] Starting Docker container: ${containerName}`);

    const githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const namespace = getNamespace();

    this.activeDockerContainers.add(containerName);
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = runDockerAgent({
          containerName,
          repoUrl: job.repoUrl,
          task: injectPreamble(job.task, job.preamble),
          anthropicToken: token,
          githubToken,
          namespace,
        });

        this.kills.set(job.id, () => proc.kill());

        proc.on("text", (line: string) => {
          if ((line as string).trim()) this.addOutput(job, line as string);
        });

        proc.on("error", (err: unknown) => { reject(err); });

        proc.on("exit", (code: number) => {
          job.exitCode = code ?? undefined;
          this.kills.delete(job.id);
          if (code === 0 || code === null) resolve();
          else reject(new Error(`Docker container exited with code ${code}`));
        });
      });

      job.status = "done";
      logger.info("job:done", { id: job.id, exitCode: job.exitCode ?? 0, mode: "docker" });
      this.addOutput(job, `[cc-agent] Done (Docker). Exit code: ${job.exitCode ?? 0}`);
    } catch (err) {
      job.status = "failed";
      job.error = String(err);
      logger.error("job:failed", { id: job.id, error: job.error, mode: "docker" });
      this.addOutput(job, `[cc-agent] FAILED (Docker): ${job.error}`);
    } finally {
      this.activeDockerContainers.delete(containerName);
      job.finishedAt = new Date();
      this.persistJob(job);
    }
  }

  private async cleanupDockerContainers(): Promise<void> {
    if (this.activeDockerContainers.size === 0) return;
    logger.info("docker:cleanup", { containers: Array.from(this.activeDockerContainers) });
    const containers = Array.from(this.activeDockerContainers);
    this.activeDockerContainers.clear();
    await Promise.allSettled(
      containers.map((name) =>
        execFileAsync("docker", ["rm", "-f", name], { env: getDockerEnv() } as Parameters<typeof execFileAsync>[2]).catch(() => {})
      )
    );
  }

  private async writeModelRating(job: Job): Promise<void> {
    const ratingsDir = join(homedir(), ".cc-agent");
    await mkdir(ratingsDir, { recursive: true });
    const ratingsFile = join(ratingsDir, "model-ratings.jsonl");
    const entry = {
      timestamp: new Date().toISOString(),
      model: job.ollamaModel,
      provider: "ollama",
      job_id: job.id,
      repo: job.repoUrl,
      exit_code: job.exitCode ?? 0,
      output_lines: job.output.length,
      task_summary: job.task.slice(0, 100),
      rating: null,
      notes: null,
    };
    await appendFile(ratingsFile, JSON.stringify(entry) + "\n", "utf-8");
    logger.info("model-rating:written", { job_id: job.id, model: job.ollamaModel });
  }

  private scheduleWake(job: Job): void {
    const sleepUntil = job.sleepUntil ? new Date(job.sleepUntil) : new Date(Date.now() + 60 * 60 * 1000);
    const delay = Math.max(0, sleepUntil.getTime() - Date.now());
    logger.info("job:schedule-wake", { id: job.id, sleepUntil: sleepUntil.toISOString(), delayMs: delay });
    const timer = setTimeout(() => {
      this.wakeTimers.delete(job.id);
      this.doWake(job);
    }, delay);
    timer.unref();
    this.wakeTimers.set(job.id, timer);
  }

  private doWake(job: Job): void {
    if (job.status !== "sleeping") return;
    logger.info("job:waking", { id: job.id });
    job.sleepUntil = undefined;
    this.persistJob(job);
    this.addOutput(job, `[cc-agent] Waking up, resuming task...`);
    this.run(job, job.claudeToken ?? this.defaultToken).catch((err) => {
      job.status = "failed";
      job.error = String(err);
      job.finishedAt = new Date();
      this.persistJob(job);
    });
  }

  async wakeJob(id: string): Promise<{ status: string; message: string }> {
    const job = this.jobs.get(id);
    if (!job) return { status: "error", message: "Job not found" };
    if (job.status !== "sleeping") return { status: "error", message: `Job is not sleeping (status: ${job.status})` };
    const timer = this.wakeTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.wakeTimers.delete(id);
    }
    this.doWake(job);
    return { status: "ok", message: `Job ${id} woken up.` };
  }

  private tick(): void {
    for (const [, job] of this.jobs) {
      if (job.status !== "pending") continue;
      if (!job.dependsOn?.length) { this.promote(job); continue; }
      const allDone = job.dependsOn.every((depId) => this.jobs.get(depId)?.status === "done");
      const anyFailed = job.dependsOn.some((depId) => {
        const s = this.jobs.get(depId)?.status;
        return s === "failed" || s === "cancelled";
      });
      if (anyFailed) {
        job.status = "failed";
        job.error = "Dependency failed";
        job.finishedAt = new Date();
        logger.warn("job:dep-failed", { id: job.id });
        this.persistJob(job);
      } else if (allDone) {
        logger.info("job:promoting", { id: job.id });
        this.promote(job);
      }
    }
  }

  private promote(job: Job): void {
    this.run(job, job.claudeToken ?? this.defaultToken).catch((err) => {
      job.status = "failed";
      job.error = String(err);
      job.finishedAt = new Date();
      this.persistJob(job);
    });
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  async getOutput(id: string, offset = 0): Promise<{ lines: string[]; done: boolean; toolCalls: string[] }> {
    const job = this.jobs.get(id);
    if (!job) {
      const lines = await jobStore.getOutput(id, offset);
      return { lines, done: true, toolCalls: [] };
    }
    const done = job.status === "done" || job.status === "failed" || job.status === "cancelled" || job.status === "rejected";
    if (this.restoredJobs.has(id)) {
      return { lines: await jobStore.getOutput(id, offset), done, toolCalls: job.toolCalls };
    }
    return { lines: job.output.slice(offset), done, toolCalls: job.toolCalls };
  }

  list(): JobSummary[] {
    return Array.from(this.jobs.values()).map((j) => ({
      id: j.id,
      status: j.status,
      repoUrl: j.repoUrl,
      task: j.task.slice(0, 120) + (j.task.length > 120 ? "..." : ""),
      branch: j.branch,
      createBranch: j.createBranch,
      startedAt: j.startedAt.toISOString(),
      finishedAt: j.finishedAt?.toISOString(),
      exitCode: j.exitCode,
      error: j.error,
      recentTools: j.toolCalls.slice(-10),
      sessionIdAfter: j.sessionIdAfter,
      costUsd: j.costUsd,
      usage: j.usage,
      totalInputTokens: j.totalInputTokens,
      totalOutputTokens: j.totalOutputTokens,
      totalCacheReadTokens: j.totalCacheReadTokens,
      totalCacheWriteTokens: j.totalCacheWriteTokens,
      score: j.score ?? null,
      scoreSource: j.scoreSource ?? null,
      variantIndex: j.variantIndex,
      parentVariant: j.parentVariant,
      siblings: j.siblings,
      isolation: j.dockerIsolation ? "docker" as const : "host" as const,
      resumedFrom: j.resumedFrom,
    }));
  }

  sendMessage(id: string, message: string): { ok: boolean; error?: string } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: "Job not found" };
    if (job.status !== "running") return { ok: false, error: "Agent is not running, cannot send message" };
    if (!job.stdinStream || job.stdinStream.destroyed) {
      return { ok: false, error: "Agent stdin is not available (may not support interactive input)" };
    }
    job.stdinStream.write(message + "\n");
    return { ok: true };
  }

  setJobScore(id: string, score: number, reason?: string): { ok: boolean; error?: string; score?: number } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: "Job not found" };
    job.score = Math.min(1.0, Math.max(0.0, score));
    this.persistJob(job);
    this.addOutput(job, `[cc-agent] Score set to ${job.score}${reason ? ": " + reason : ""}`);
    return { ok: true, score: job.score };
  }

  setJobSiblings(id: string, siblings: string[]): void {
    const job = this.jobs.get(id);
    if (job) {
      job.siblings = siblings;
      this.persistJob(job);
    }
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (
      job.status !== "pending" && job.status !== "cloning" &&
      job.status !== "running" && job.status !== "sleeping" &&
      job.status !== "pending_approval"
    ) return false;

    // Clear wake timer if sleeping
    const timer = this.wakeTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.wakeTimers.delete(id);
    }

    // Clear approval poller if pending_approval
    const poller = this.approvalPollers.get(id);
    if (poller) {
      clearInterval(poller.intervalId);
      this.approvalPollers.delete(id);
    }

    const kill = this.kills.get(id);
    if (kill) {
      kill();
      this.kills.delete(id);
    }

    job.status = "cancelled";
    job.finishedAt = new Date();
    logger.info("job:cancelled", { id });
    this.addOutput(job, "[cc-agent] Cancelled by user.");
    this.persistJob(job);
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (
        (job.status === "done" || job.status === "failed" || job.status === "cancelled" || job.status === "rejected") &&
        job.finishedAt &&
        now - job.finishedAt.getTime() > JOB_TTL_MS
      ) {
        this.jobs.delete(id);
        this.restoredJobs.delete(id);
      }
    }
  }
}
