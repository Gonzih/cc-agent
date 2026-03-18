import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import { runClaude } from "./claude.js";
import type { Job, JobSummary, SpawnOptions } from "./types.js";
import {
  ensureStateDirs,
  loadPersistedJobs,
  savePersistedJobs,
  appendLog,
  readLogSync,
  isPidAlive,
  type PersistedJob,
} from "./state.js";

const execFileAsync = promisify(execFile);

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour — clean up old done jobs

export class JobManager {
  private jobs = new Map<string, Job>();
  private kills = new Map<string, () => void>();
  private defaultToken?: string;
  private diskLoadedJobs = new Set<string>();

  constructor(token?: string) {
    this.defaultToken = token;
    ensureStateDirs();
    this.loadFromDisk();
    // Periodic cleanup of old finished jobs
    setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
    // Periodic check for disk-loaded running jobs whose PID may have died
    setInterval(() => this.checkDiskLoadedRunning(), 30 * 1000).unref();
  }

  private loadFromDisk(): void {
    const persisted = loadPersistedJobs();
    const updated: PersistedJob[] = [];

    for (const p of persisted) {
      let status = p.status;
      let error = p.error;
      let finishedAt = p.finishedAt;

      if (status === "running" || status === "cloning") {
        if (p.pid && isPidAlive(p.pid)) {
          // Still alive — keep as running, output reads from disk log
        } else {
          status = "failed";
          error = (error ? error + "; " : "") + "Process not found after restart";
          finishedAt = finishedAt ?? new Date().toISOString();
        }
      }

      const job: Job = {
        id: p.id,
        repoUrl: p.repoUrl,
        task: p.task,
        branch: p.branch,
        createBranch: p.createBranch,
        status,
        output: [],
        exitCode: p.exitCode,
        error,
        startedAt: new Date(p.startedAt),
        finishedAt: finishedAt ? new Date(finishedAt) : undefined,
        pid: p.pid,
      };

      this.jobs.set(job.id, job);
      this.diskLoadedJobs.add(job.id);
      updated.push({ ...p, status, error, finishedAt });
    }

    if (updated.length > 0) {
      savePersistedJobs(updated);
    }
  }

  private checkDiskLoadedRunning(): void {
    for (const id of this.diskLoadedJobs) {
      const job = this.jobs.get(id);
      if (!job) continue;
      if (job.status === "running" || job.status === "cloning") {
        if (!job.pid || !isPidAlive(job.pid)) {
          job.status = "failed";
          job.finishedAt = new Date();
          job.error = (job.error ? job.error + "; " : "") + "Process exited after MCP restart";
          this.persistJob(job);
          appendLog(job.id, "[cc-agent] Process no longer alive after MCP restart");
        }
      }
    }
  }

  private persistJob(job: Job): void {
    const persisted = loadPersistedJobs();
    const entry: PersistedJob = {
      id: job.id,
      status: job.status,
      repoUrl: job.repoUrl,
      task: job.task,
      branch: job.branch,
      createBranch: job.createBranch,
      startedAt: job.startedAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString(),
      exitCode: job.exitCode,
      error: job.error,
      pid: job.pid,
    };
    const idx = persisted.findIndex((p) => p.id === job.id);
    if (idx >= 0) {
      persisted[idx] = entry;
    } else {
      persisted.push(entry);
    }
    savePersistedJobs(persisted);
  }

  private addOutput(job: Job, line: string): void {
    job.output.push(line);
    appendLog(job.id, line);
  }

  async spawn(opts: SpawnOptions): Promise<string> {
    const id = uuidv4();
    const job: Job = {
      id,
      repoUrl: opts.repoUrl,
      task: opts.task,
      branch: opts.branch,
      createBranch: opts.createBranch,
      status: "cloning",
      output: [],
      startedAt: new Date(),
    };
    this.jobs.set(id, job);
    this.persistJob(job);

    // Run async — don't await
    this.run(job, opts.claudeToken ?? this.defaultToken).catch((err) => {
      job.status = "failed";
      job.error = String(err);
      job.finishedAt = new Date();
      this.persistJob(job);
    });

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
      if (job.branch) cloneArgs.push("--branch", job.branch);
      cloneArgs.push(job.repoUrl, workDir);

      await execFileAsync("git", cloneArgs);
      this.addOutput(job, `[cc-agent] Cloned to ${workDir}`);

      // 2. Create branch if requested
      if (job.createBranch) {
        await execFileAsync("git", ["checkout", "-b", job.createBranch], { cwd: workDir });
        this.addOutput(job, `[cc-agent] Created branch: ${job.createBranch}`);
      }

      // 3. Run Claude
      job.status = "running";
      this.persistJob(job);
      this.addOutput(job, `[cc-agent] Starting Claude with task...`);

      await new Promise<void>((resolve, reject) => {
        const proc = runClaude(job.task, workDir!, token);

        // Save PID for cross-restart tracking
        if (proc.pid != null) {
          job.pid = proc.pid;
          this.persistJob(job);
        }

        this.kills.set(job.id, () => proc.kill());
        job.stdinStream = proc.stdin ?? null;

        proc.on("text", (text) => {
          if (text.trim()) this.addOutput(job, text);
        });

        proc.on("error", (err) => {
          reject(err);
        });

        proc.on("exit", (code) => {
          job.exitCode = code ?? undefined;
          job.stdinStream = null;
          this.kills.delete(job.id);
          if (code === 0 || code === null) {
            resolve();
          } else {
            reject(new Error(`Claude exited with code ${code}`));
          }
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
      // Clean up work dir after 10 minutes to allow output inspection
      if (workDir) {
        setTimeout(() => rm(workDir!, { recursive: true, force: true }).catch(() => {}), 10 * 60 * 1000).unref();
      }
    }
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  getOutput(id: string, offset = 0): { lines: string[]; done: boolean } {
    const job = this.jobs.get(id);
    if (!job) {
      // Job not in memory (expired or unknown) — try disk log
      const lines = readLogSync(id, offset);
      return { lines, done: true };
    }
    const done = job.status === "done" || job.status === "failed" || job.status === "cancelled";
    if (this.diskLoadedJobs.has(id)) {
      // Output lives on disk for jobs recovered after restart
      return { lines: readLogSync(id, offset), done };
    }
    return { lines: job.output.slice(offset), done };
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
    if (job.status !== "cloning" && job.status !== "running") return false;

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
        this.diskLoadedJobs.delete(id);
      }
    }
  }
}
