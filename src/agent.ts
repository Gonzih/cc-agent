import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import { runClaude } from "./claude.js";
import type { Job, JobStatus, JobSummary, SpawnOptions } from "./types.js";

const execFileAsync = promisify(execFile);

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour — clean up old done jobs

export class JobManager {
  private jobs = new Map<string, Job>();
  private kills = new Map<string, () => void>();
  private defaultToken?: string;

  constructor(token?: string) {
    this.defaultToken = token;
    // Periodic cleanup of old finished jobs
    setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
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

    // Run async — don't await
    this.run(job, opts.claudeToken ?? this.defaultToken).catch((err) => {
      job.status = "failed";
      job.error = String(err);
      job.finishedAt = new Date();
    });

    return id;
  }

  private async run(job: Job, token?: string): Promise<void> {
    let workDir: string | undefined;
    try {
      // 1. Clone
      workDir = await mkdtemp(join(tmpdir(), `cc-agent-${job.id.slice(0, 8)}-`));
      job.workDir = workDir;
      job.output.push(`[cc-agent] Cloning ${job.repoUrl}...`);

      const cloneArgs = ["clone", "--depth", "1"];
      if (job.branch) cloneArgs.push("--branch", job.branch);
      cloneArgs.push(job.repoUrl, workDir);

      await execFileAsync("git", cloneArgs);
      job.output.push(`[cc-agent] Cloned to ${workDir}`);

      // 2. Create branch if requested
      if (job.createBranch) {
        await execFileAsync("git", ["checkout", "-b", job.createBranch], { cwd: workDir });
        job.output.push(`[cc-agent] Created branch: ${job.createBranch}`);
      }

      // 3. Run Claude
      job.status = "running";
      job.output.push(`[cc-agent] Starting Claude with task...`);

      await new Promise<void>((resolve, reject) => {
        const proc = runClaude(job.task, workDir!, token);
        this.kills.set(job.id, () => proc.kill());

        proc.on("text", (text) => {
          if (text.trim()) job.output.push(text);
        });

        proc.on("error", (err) => {
          reject(err);
        });

        proc.on("exit", (code) => {
          job.exitCode = code ?? undefined;
          this.kills.delete(job.id);
          if (code === 0 || code === null) {
            resolve();
          } else {
            reject(new Error(`Claude exited with code ${code}`));
          }
        });
      });

      job.status = "done";
      job.output.push(`[cc-agent] Done. Exit code: ${job.exitCode ?? 0}`);
    } catch (err) {
      job.status = "failed";
      job.error = String(err);
      job.output.push(`[cc-agent] FAILED: ${job.error}`);
    } finally {
      job.finishedAt = new Date();
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
    if (!job) return { lines: [], done: true };
    return {
      lines: job.output.slice(offset),
      done: job.status === "done" || job.status === "failed" || job.status === "cancelled",
    };
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
    job.output.push("[cc-agent] Cancelled by user.");
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
      }
    }
  }
}
