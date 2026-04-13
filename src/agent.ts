import { execFile } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, rm, appendFile, mkdir, readFile } from "fs/promises";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import { runClaude } from "./claude.js";
import { injectPreamble, BROWSER_HINT, CODE_QUALITY_CHECKLIST, isCodeTask } from "./preamble.js";
import type { Job, JobSummary, SpawnOptions, JobEvent, CoordinatorPlan } from "./types.js";
import { ensureStateDirs, isPidAlive } from "./state.js";
import { jobStore, learningsStore, type JobRecord } from "./store.js";
import { getNamespace } from "./namespace.js";
import { logger } from "./logger.js";
import { isDockerAvailable, runDockerAgent, getDockerEnv } from "./docker.js";
import { getCurrentToken, rotateToken, getTokenStatus, resetTokens } from "./tokens.js";
import { getRedis } from "./redis.js";

const execFileAsync = promisify(execFile);

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour — clean up old done jobs from memory

export const DOCKER_PREAMBLE = `[DOCKER CONTAINER MODE]
You are running inside an isolated Docker container as user 'agent'.
You have passwordless sudo access — install any system packages you need freely:
  sudo apt-get install -y <package>
  sudo npm install -g <package>
  sudo pip install <package>
- The container is ephemeral — don't worry about cleanup or side effects
- Git, gh CLI, npm, and SSH credentials are already injected from the host
- Focus on the task — the environment is yours to modify freely
---

`;

const MACOS_NATIVE_REPO_PATTERNS = [
  /simorgh-app/i,
  /leworldmodel/i,
  /lewm/i,
  /expo-app/i,
];

const MACOS_NATIVE_TASK_PATTERNS = [
  /\bmlx\b/i,
  /\bmetal\b/i,
  /\bcore ml\b/i,
  /\bapple silicon\b/i,
  /\bxcode\b/i,
  /\bsimulator\b/i,
];

/** Returns true when Docker isolation should be skipped for this job. */
export function shouldSkipDocker(job: Pick<Job, "repoUrl" | "task"> & { requiresDocker?: boolean; dockerIsolation?: boolean }): boolean {
  // Explicit opt-in always wins — never skip if the user requested docker isolation
  if (job.dockerIsolation) return false;

  // On non-Linux (e.g. macOS), Docker isolation is opt-IN; skip unless explicitly required
  if (process.platform !== "linux" && !job.requiresDocker) {
    return true;
  }

  // Skip for macOS-native repo URLs
  if (MACOS_NATIVE_REPO_PATTERNS.some((p) => p.test(job.repoUrl))) {
    return true;
  }

  // Skip for tasks that involve macOS-native tooling
  if (MACOS_NATIVE_TASK_PATTERNS.some((p) => p.test(job.task))) {
    return true;
  }

  return false;
}

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

/** Compress a raw learnings block to bullet points only, max 8 bullets. */
function compressLearnings(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-") || l.startsWith("•"))
    .map((l) => l.replace(/^[-•]\s*/, "").trim())
    .filter((l) => l.length > 10 && l.length < 200)
    .slice(0, 8)
    .map((l) => `- ${l}`)
    .join("\n");
}

/** Derive a repo-scoped key from a repo URL.
 *  "https://github.com/Gonzih/cc-agent" → "gonzih/cc-agent"
 *  "git@github.com:Gonzih/cc-agent.git" → "gonzih/cc-agent"
 */
export function repoKey(repoUrl: string): string {
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  if (!m) return repoUrl.toLowerCase().replace(/[^a-z0-9]/g, "-");
  return `${m[1].toLowerCase()}/${m[2].replace(/\.git$/, "").toLowerCase()}`;
}

/** Normalize the owner portion of a GitHub URL to lowercase.
 *  "https://github.com/Owner/repo" → "https://github.com/owner/repo"
 *  Falls back to full lowercase on parse failure.
 */
export function normalizeRepoUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean); // ['Owner', 'repo']
    if (parts.length >= 2) {
      parts[0] = parts[0].toLowerCase();
      u.pathname = '/' + parts.join('/');
    }
    return u.toString();
  } catch {
    return url.toLowerCase();
  }
}

/** Build a preamble prefix with prior repo learnings. */
export function buildLearningsPreamble(learnings: string[], rk: string): string {
  if (!learnings.length) return "";
  const compressed = learnings.find(i => i.startsWith("[COMPRESSED SUMMARY"));
  const recents = learnings.filter(i => !i.startsWith("[COMPRESSED SUMMARY"));

  let result = `Repo notes (${rk}):\n`;
  if (compressed) {
    result += `### Synthesized History\n${compressed}\n\n`;
  }
  if (recents.length > 0) {
    result += `### Recent Observations\n${recents.map(i => `- ${i}`).join('\n')}\n`;
  }
  result += `\n---\n\n`;
  return result;
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
    tokenIndex: job.tokenIndex,
    onComplete: job.onComplete,
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
    tokenIndex: r.tokenIndex,
    onComplete: r.onComplete,
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
    // Kill all active claude subprocesses and clean up Docker containers on process exit
    const killAll = () => {
      for (const [, kill] of this.kills) {
        try { kill(); } catch {}
      }
    };
    const cleanup = () => { killAll(); void this.cleanupDockerContainers(); };
    process.once("SIGTERM", cleanup);
    process.once("SIGINT", cleanup);
    process.once("exit", killAll);
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
          // Check last output line — if Claude finished cleanly the output will say so.
          // This catches the race where cc-agent died right as a job completed.
          let looksCompleted = false;
          try {
            const lastOutput = await jobStore.getOutput(r.id, Math.max(0, r.outputLineCount - 3));
            const lastLine = lastOutput[lastOutput.length - 1] ?? "";
            looksCompleted = /Done\. Exit code:\s*0/i.test(lastLine);
          } catch { /* ignore */ }
          if (looksCompleted) {
            status = "done";
            finishedAt = finishedAt ?? new Date().toISOString();
          } else {
            status = "interrupted";
            error = (error ? error + "; " : "") + "Process not found after restart";
            finishedAt = finishedAt ?? new Date().toISOString();
            interruptedAt = interruptedAt ?? new Date().toISOString();
            orphanCount++;
          }
        }
        // else: process is alive — keep as running (owned by sibling cc-agent instance)
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
      logger.info(`[cc-agent] Marked ${orphanCount} orphaned running jobs as interrupted`);
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
          // Before marking interrupted, check Redis — another cc-agent instance may have
          // already completed this job. With multiple cc-agent processes running (one per
          // Claude Code session), restored jobs may be owned by a sibling instance.
          (async () => {
            try {
              const current = await jobStore.getJob(id);
              if (current && current.status !== "running" && current.status !== "cloning") {
                // Sibling instance already resolved this job — sync local state and stop tracking
                const resolved = fromRecord(current);
                this.jobs.set(id, resolved);
                this.restoredJobs.delete(id);
                logger.info("job:synced-from-redis", { id, status: current.status });
                return;
              }
            } catch { /* ignore — fall through to interrupt */ }
            // PID dead and Redis still shows running — genuinely orphaned
            job.status = "interrupted";
            job.finishedAt = new Date();
            job.interruptedAt = job.interruptedAt ?? new Date();
            job.error = (job.error ? job.error + "; " : "") + "Process exited after MCP restart";
            logger.warn("job:process-died", { id, pid: job.pid });
            this.persistJob(job);
            this.addOutput(job, "[cc-agent] Process no longer alive after MCP restart");
          })().catch(() => {});
        }
      }
    }
  }

  private persistJob(job: Job): void {
    jobStore.saveJob(toRecord(job)).catch(() => {});
  }

  private publishJobEvent(job: Job): void {
    const redis = getRedis();
    if (!redis) return;
    (async () => {
      try {
        const [lastLines, planRaw] = await Promise.all([
          redis.lrange(`cca:job:${job.id}:output`, -5, -1),
          redis.get(`cca:coordinator:plan:${job.id}`),
        ]);
        const event: JobEvent = {
          jobId: job.id,
          status: job.status,
          title: job.task.split('\n')[0].slice(0, 120),
          repoUrl: job.repoUrl,
          lastLines,
          score: job.score ?? undefined,
          timestamp: Date.now(),
          coordinatorPlan: planRaw ? (JSON.parse(planRaw) as CoordinatorPlan) : undefined,
        };
        // Write to Redis Stream for durability (fire-and-forget, never crash on failure)
        try {
          await redis.xadd(
            'cca:event-stream', '*',
            'jobId', event.jobId,
            'status', event.status,
            'title', event.title,
            'repoUrl', event.repoUrl,
            'lastLines', JSON.stringify(event.lastLines),
            'coordinatorPlan', JSON.stringify(event.coordinatorPlan ?? null),
            'score', event.score !== undefined ? String(event.score) : '',
            'timestamp', String(event.timestamp),
          );
          await redis.xtrim('cca:event-stream', 'MAXLEN', '~', '500');
        } catch (streamErr) {
          logger.warn('job:stream-write-failed', { id: job.id, err: String(streamErr) });
        }
      } catch (err) {
        logger.warn('job:event-publish-failed', { id: job.id, err: String(err) });
      }
    })();
  }

  private addOutput(job: Job, text: string): void {
    const lines = text.split('\n');
    for (const line of lines) {
      job.output.push(line);
      jobStore.appendOutput(job.id, line).catch(() => {});
    }
  }

  async spawn(opts: SpawnOptions): Promise<string> {
    // Prepend prior repo learnings to the task
    const rk = repoKey(opts.repoUrl);
    const priorLearnings = await learningsStore.getLearnings(rk, 6);
    let task = opts.task;
    if (priorLearnings.length) {
      const firstLine = opts.task.split('\n')[0];
      const restOfTask = opts.task.slice(firstLine.length);
      task = `${firstLine}\n\n${buildLearningsPreamble(priorLearnings, rk)}${restOfTask}`;
    }


    // Check if gstack browser daemon is available on the host
    let hasBrowser = false;
    try {
      await execFileAsync("which", ["gstack"]);
      hasBrowser = true;
    } catch { /* not available */ }

    if (hasBrowser) task += BROWSER_HINT;
    if (isCodeTask(task)) task += CODE_QUALITY_CHECKLIST;

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
      onComplete: opts.onComplete,
    };
    this.jobs.set(id, job);
    this.persistJob(job);
    logger.info("job:spawned", { id, status: job.status, repoUrl: opts.repoUrl });

    if (!isPending && !requiresApproval) {
      const effectiveToken = (opts.claudeToken ?? await getCurrentToken()) || this.defaultToken;
      this.run(job, effectiveToken).catch((err) => {
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
        this.publishJobEvent(job);
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
    const runWithToken = async () => {
      const token = (job.claudeToken ?? await getCurrentToken()) || this.defaultToken;
      return this.run(job, token);
    };
    runWithToken().catch((err) => {
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
      if (shouldSkipDocker(job)) {
        logger.info("[cc-agent] Skipping Docker isolation — native macOS/ML workload detected", { id: job.id });
        this.addOutput(job, "[cc-agent] Skipping Docker isolation — native macOS/ML workload detected");
        // Fall through to host mode without mutating job.dockerIsolation
      } else {
        await this.runDockerIsolated(job, token);
        return;
      }
    }

    // If resuming from sleep and the workDir still exists, skip clone/branch.
    const isResume = !!(job.workDir && existsSync(job.workDir));
    let workDir: string | undefined = isResume ? job.workDir : undefined;
    let sleepRequested = false;
    let tokenRotationRequested = false;

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
            this.publishJobEvent(job);
            return;
          }
        }
      }

      // 3b. Inject AGENTS.md or .cc-agent/notes.md as repo context if present
      let repoContext = '';
      const agentsMdPath = join(workDir!, 'AGENTS.md');
      const ccAgentNotesPath = join(workDir!, '.cc-agent', 'notes.md');
      if (existsSync(agentsMdPath)) {
        const content = await readFile(agentsMdPath, 'utf-8');
        repoContext = `\n\n## Repo Context (from AGENTS.md)\n${content.trim()}\n`;
        logger.info("job:agents-md-injected", { id: job.id, bytes: content.length });
      } else if (existsSync(ccAgentNotesPath)) {
        const content = await readFile(ccAgentNotesPath, 'utf-8');
        repoContext = `\n\n## Repo Context (from .cc-agent/notes.md)\n${content.trim()}\n`;
        logger.info("job:cc-agent-notes-injected", { id: job.id, bytes: content.length });
      }

      // 4. Run Claude
      job.status = "running";
      this.persistJob(job);
      this.publishJobEvent(job);
      logger.info("job:running", { id: job.id, isResume });
      this.addOutput(job, isResume
        ? `[cc-agent] Resuming Claude after sleep...`
        : `[cc-agent] Starting Claude with task...`);

      await new Promise<void>((resolve, reject) => {
        const proc = runClaude(injectPreamble(job.task + repoContext, job.preamble), workDir!, token, {
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

        // --- Signal key polling (cancel/wake) and input polling ---
        const redis = getRedis();
        let signalPoller: ReturnType<typeof setInterval> | null = null;
        let inputPoller: ReturnType<typeof setInterval> | null = null;
        const stopPollers = () => {
          if (signalPoller) { clearInterval(signalPoller); signalPoller = null; }
          if (inputPoller) { clearInterval(inputPoller); inputPoller = null; }
        };

        if (redis) {
          // Fix 2: Poll cca:job:{id}:signal every 4s for cancel/wake
          signalPoller = setInterval(async () => {
            try {
              const sig = await redis.get(`cca:job:${job.id}:signal`);
              if (!sig) return;
              await redis.del(`cca:job:${job.id}:signal`);
              if (sig === 'cancel') {
                stopPollers();
                job.status = 'cancelled';
                job.finishedAt = new Date();
                this.addOutput(job, '[cc-agent] Cancelled via signal key.');
                this.persistJob(job);
                this.publishJobEvent(job);
                proc.kill();
              }
              // 'wake' signal is only relevant when sleeping; ignore here
            } catch { /* ignore polling errors */ }
          }, 4000);
          (signalPoller as NodeJS.Timeout).unref();

          // Fix 4: Poll cca:job:{id}:input every 3s for in-flight messages
          inputPoller = setInterval(async () => {
            try {
              if (!proc.stdin || proc.stdin.destroyed) return;
              const raw = await redis.rpop(`cca:job:${job.id}:input`);
              if (raw) {
                let content: string;
                try {
                  const parsed = JSON.parse(raw) as { id?: string; content?: string; timestamp?: string };
                  content = parsed.content ?? raw;
                } catch {
                  content = raw;
                }
                proc.stdin.write(`\n<Human>\n${content}\n`);
                this.addOutput(job, `[cc-agent] Injected input from Redis queue.`);
              }
            } catch { /* ignore polling errors */ }
          }, 3000);
          (inputPoller as NodeJS.Timeout).unref();
        }
        // ----------------------------------------------------------

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
          // Detect usage/rate limit messages — try rotating token first, then sleep
          if (!sleepRequested && !tokenRotationRequested && job.output.length > 3 && isLimitMessage(text)) {
            // Async: rotate token and decide whether to sleep or retry
            (async () => {
              await rotateToken();
              const status = await getTokenStatus();
              if (!status.allExhausted) {
                tokenRotationRequested = true;
                logger.warn("job:token-rotated", {
                  id: job.id,
                  newIndex: status.index,
                  total: status.total,
                });
                this.addOutput(job, `[cc-agent] Token ${status.index}/${status.total} exhausted, rotating to next`);
                job.tokenIndex = status.index;
                this.persistJob(job);
                proc.kill();
              } else {
                sleepRequested = true;
                const wakeAt = parseResetTime(text);
                job.status = "sleeping";
                job.sleepUntil = wakeAt.toISOString();
                job.sleepReason = text.trim().slice(0, 500);
                this.persistJob(job);
                this.publishJobEvent(job);
                logger.warn("job:sleeping", { id: job.id, sleepUntil: job.sleepUntil, triggeringText: text.trim().slice(0, 500) });
                this.addOutput(job, `[cc-agent] All tokens exhausted. Sleeping until ${job.sleepUntil}`);
                proc.kill();
              }
            })().catch(() => {
              // Fallback: sleep as before
              sleepRequested = true;
              proc.kill();
            });
          }
        });

        proc.on("tool", (name: string) => {
          job.toolCalls.push(name);
          if (job.toolCalls.length > 50) job.toolCalls = job.toolCalls.slice(-50);
          this.addOutput(job, `[tool] ${name}`);
        });

        proc.on("error", (err) => { reject(err); });

        proc.on("exit", (code) => {
          stopPollers();
          job.exitCode = code ?? undefined;
          job.stdinStream = null;
          this.kills.delete(job.id);
          // Resolve on sleep/rotation (we killed the proc intentionally) or clean exit
          if (sleepRequested || tokenRotationRequested || code === 0 || code === null) resolve();
          // Cancelled via signal key — resolve cleanly (job already marked cancelled)
          else if (job.status === 'cancelled') resolve();
          else reject(new Error(`Claude exited with code ${code}`));
        });
      });

      if (tokenRotationRequested) {
        // Immediately re-run with the newly rotated token (no sleep)
        const nextToken = (job.claudeToken ?? await getCurrentToken()) || this.defaultToken;
        logger.info("job:token-rotation-restart", { id: job.id, tokenIndex: job.tokenIndex });
        await this.run(job, nextToken);
        return;
      }

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
      this.publishJobEvent(job);

      // Trigger onComplete chain if configured
      if (job.onComplete) {
        const oc = job.onComplete;
        this.spawn({ repoUrl: oc.repo_url, task: oc.task, branch: oc.branch }).then((childId) => {
          logger.info("job:oncomplete-spawned", { parentId: job.id, childId });
          this.addOutput(job, `[cc-agent] onComplete: spawned child job ${childId}`);
        }).catch((err) => {
          logger.warn("job:oncomplete-spawn-failed", { parentId: job.id, err: String(err) });
          this.addOutput(job, `[cc-agent] onComplete spawn failed: ${String(err)}`);
          this.publishJobEvent(job);
        });
      }

      // Extract and store learnings scoped to the repo
      const learnings = extractLearnings(job.output);
      if (learnings) {
        const rk = repoKey(job.repoUrl);
        const compressed = compressLearnings(learnings);
        if (compressed) {
          learningsStore.addLearning(rk, compressed).catch(() => {});
          logger.info("job:learnings-extracted", { id: job.id, repoKey: rk, length: compressed.length });
        }
      }

      // Read plan artifacts if they exist — attach to job output for coordinator visibility
      if (workDir) {
        const planPath = join(workDir, 'PLAN.md');
        const todoPath = join(workDir, 'TODO.md');
        if (existsSync(planPath)) {
          try {
            const planContent = await readFile(planPath, 'utf-8');
            this.addOutput(job, `[cc-agent] PLAN.md:\n${planContent.trim()}`);
            logger.info("job:plan-artifact-read", { id: job.id, bytes: planContent.length });
          } catch { /* non-fatal */ }
        }
        if (existsSync(todoPath)) {
          try {
            const todoContent = await readFile(todoPath, 'utf-8');
            this.addOutput(job, `[cc-agent] TODO.md:\n${todoContent.trim()}`);
            logger.info("job:todo-artifact-read", { id: job.id, bytes: todoContent.length });
          } catch { /* non-fatal */ }
        }
      }

      if (job.ollamaModel) {
        this.writeModelRating(job).catch(() => {});
      }
    } catch (err) {
      if (!sleepRequested && !tokenRotationRequested) {
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
        this.publishJobEvent(job);
      }
    } finally {
      if (!sleepRequested && !tokenRotationRequested) {
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
    this.addOutput(job, `[cc-agent] Docker isolation requested — spawning container ${containerName}`);
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
          task: injectPreamble(DOCKER_PREAMBLE + job.task, job.preamble),
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
      this.publishJobEvent(job);
      // Trigger onComplete chain if job finished successfully
      if (job.status === "done" && job.onComplete) {
        const oc = job.onComplete;
        this.spawn({ repoUrl: oc.repo_url, task: oc.task, branch: oc.branch }).then((childId) => {
          logger.info("job:oncomplete-spawned", { parentId: job.id, childId });
          this.addOutput(job, `[cc-agent] onComplete: spawned child job ${childId}`);
        }).catch((err2) => {
          logger.warn("job:oncomplete-spawn-failed", { parentId: job.id, err: String(err2) });
          this.addOutput(job, `[cc-agent] onComplete spawn failed: ${String(err2)}`);
        });
      }
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

    // Fix 2: Poll for wake signal while sleeping so remote callers can wake early
    const redis = getRedis();
    if (redis) {
      const wakePoller = setInterval(async () => {
        if (job.status !== 'sleeping') { clearInterval(wakePoller); return; }
        try {
          const sig = await redis.get(`cca:job:${job.id}:signal`);
          if (sig === 'wake') {
            await redis.del(`cca:job:${job.id}:signal`);
            clearInterval(wakePoller);
            const t = this.wakeTimers.get(job.id);
            if (t) { clearTimeout(t); this.wakeTimers.delete(job.id); }
            this.doWake(job);
          }
        } catch { /* ignore */ }
      }, 4000);
      (wakePoller as NodeJS.Timeout).unref();
    }
  }

  private doWake(job: Job): void {
    if (job.status !== "sleeping") return;
    logger.info("job:waking", { id: job.id });
    job.sleepUntil = undefined;
    this.persistJob(job);
    this.addOutput(job, `[cc-agent] Waking up, resuming task...`);
    const runWithToken = async () => {
      // On wake after all-exhausted sleep, reset token counter so rotation starts fresh
      await resetTokens();
      const token = (job.claudeToken ?? await getCurrentToken()) || this.defaultToken;
      return this.run(job, token);
    };
    runWithToken().catch((err) => {
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
        this.publishJobEvent(job);
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
      // Job not in this instance's memory — may be owned by a sibling cc-agent process.
      // Check Redis for the real status before assuming it's done.
      const record = await jobStore.getJob(id);
      const lines = await jobStore.getOutput(id, offset);
      const TERMINAL = ["done", "failed", "cancelled", "rejected", "interrupted"];
      const done = !record || TERMINAL.includes(record.status);
      return { lines, done, toolCalls: [] };
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

  async sendMessage(id: string, message: string): Promise<{ ok: boolean; error?: string }> {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: "Job not found" };
    if (job.status !== "running") return { ok: false, error: "Agent is not running, cannot send message" };
    const redis = getRedis();
    if (!redis) return { ok: false, error: "Redis not available" };
    const entry = JSON.stringify({ id: uuidv4(), content: message, timestamp: new Date().toISOString() });
    await redis.lpush(`cca:job:${id}:input`, entry);
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
    this.publishJobEvent(job);
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
