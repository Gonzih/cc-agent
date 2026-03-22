import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import { runClaude } from "./claude.js";
import { injectPreamble } from "./preamble.js";
import type { Job, JobSummary, SpawnOptions } from "./types.js";
import { ensureStateDirs, isPidAlive } from "./state.js";
import { jobStore, type JobRecord } from "./store.js";

const execFileAsync = promisify(execFile);

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour — clean up old done jobs from memory

// Claude Sonnet 4.6 pricing (USD per 1M tokens)
const PRICE_INPUT = 3.00;
const PRICE_OUTPUT = 15.00;
const PRICE_CACHE_READ = 0.30;
const PRICE_CACHE_WRITE = 3.75;

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
  };
}

export class JobManager {
  private jobs = new Map<string, Job>();
  private kills = new Map<string, () => void>();
  private defaultToken?: string;
  /** Jobs restored from storage — their output lives in store, not in job.output[]. */
  private restoredJobs = new Set<string>();

  constructor(token?: string) {
    this.defaultToken = token;
    ensureStateDirs();
    // Periodic cleanup of old finished jobs
    setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
    // Periodic check for restored running jobs whose PID may have died
    setInterval(() => this.checkRestoredRunning(), 30 * 1000).unref();
    // Dependency scheduler — promote pending jobs when deps are done
    setInterval(() => this.tick(), 3000).unref();
  }

  /** Must be called after initRedis() at startup. */
  async init(): Promise<void> {
    const records = await jobStore.loadAll();
    const updates: Array<JobRecord> = [];

    for (const r of records) {
      let status = r.status;
      let error = r.error;
      let finishedAt = r.finishedAt;

      if (status === "running" || status === "cloning") {
        if (r.pid && isPidAlive(r.pid)) {
          // Process still alive — keep as running
        } else {
          status = "failed";
          error = (error ? error + "; " : "") + "Process not found after restart";
          finishedAt = finishedAt ?? new Date().toISOString();
        }
      }

      const job = fromRecord({ ...r, status, error, finishedAt });
      this.jobs.set(job.id, job);
      this.restoredJobs.add(job.id);

      if (status !== r.status) {
        updates.push({ ...r, status, error, finishedAt });
      }
    }

    // Persist any status corrections back to store
    for (const updated of updates) {
      jobStore.saveJob(updated).catch(() => {});
    }
  }

  private checkRestoredRunning(): void {
    for (const id of this.restoredJobs) {
      const job = this.jobs.get(id);
      if (!job) continue;
      if (job.status === "running" || job.status === "cloning") {
        if (!job.pid || !isPidAlive(job.pid)) {
          job.status = "failed";
          job.finishedAt = new Date();
          job.error = (job.error ? job.error + "; " : "") + "Process exited after MCP restart";
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
    const id = uuidv4();
    const pendingDeps = opts.dependsOn?.filter((depId) => {
      const dep = this.jobs.get(depId);
      return dep?.status !== "done";
    });
    const isPending = pendingDeps && pendingDeps.length > 0;
    const job: Job = {
      id,
      repoUrl: opts.repoUrl,
      task: opts.task,
      branch: opts.branch,
      createBranch: opts.createBranch,
      continueSession: opts.continueSession,
      maxBudgetUsd: opts.maxBudgetUsd ?? 20,
      sessionId: opts.sessionId,
      claudeToken: opts.claudeToken,
      dependsOn: opts.dependsOn,
      preamble: opts.preamble,
      status: isPending ? "pending" : "cloning",
      output: [],
      toolCalls: [],
      startedAt: new Date(),
    };
    this.jobs.set(id, job);
    this.persistJob(job);

    if (!isPending) {
      this.run(job, opts.claudeToken ?? this.defaultToken).catch((err) => {
        job.status = "failed";
        job.error = String(err);
        job.finishedAt = new Date();
        this.persistJob(job);
      });
    }

    return id;
  }

  private async run(job: Job, token?: string): Promise<void> {
    let workDir: string | undefined;
    try {
      // 1. Clone
      workDir = await mkdtemp(join(tmpdir(), `cc-agent-${job.id.slice(0, 8)}-`));
      job.workDir = workDir;
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

      // 3. Run Claude
      job.status = "running";
      this.persistJob(job);
      this.addOutput(job, `[cc-agent] Starting Claude with task...`);

      await new Promise<void>((resolve, reject) => {
        const proc = runClaude(injectPreamble(job.task, job.preamble), workDir!, token, {
          continueSession: job.continueSession,
          maxBudgetUsd: job.maxBudgetUsd,
          sessionId: job.sessionId,
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
          if (code === 0 || code === null) resolve();
          else reject(new Error(`Claude exited with code ${code}`));
        });
      });

      job.status = "done";
      this.addOutput(job, `[cc-agent] Done. Exit code: ${job.exitCode ?? 0}`);
      this.persistJob(job);
    } catch (err) {
      job.status = "failed";
      job.error = String(err);
      this.addOutput(job, `[cc-agent] FAILED: ${job.error}`);
      this.persistJob(job);
    } finally {
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
        this.persistJob(job);
      } else if (allDone) {
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
    const done = job.status === "done" || job.status === "failed" || job.status === "cancelled";
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

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status !== "pending" && job.status !== "cloning" && job.status !== "running") return false;

    const kill = this.kills.get(id);
    if (kill) {
      kill();
      this.kills.delete(id);
    }

    job.status = "cancelled";
    job.finishedAt = new Date();
    this.addOutput(job, "[cc-agent] Cancelled by user.");
    this.persistJob(job);
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (
        (job.status === "done" || job.status === "failed" || job.status === "cancelled") &&
        job.finishedAt &&
        now - job.finishedAt.getTime() > JOB_TTL_MS
      ) {
        this.jobs.delete(id);
        this.restoredJobs.delete(id);
      }
    }
  }
}
