import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { JobStatus } from "./types.js";

export const STATE_DIR = join(homedir(), ".cc-agent");
export const JOBS_FILE = join(STATE_DIR, "jobs.json");
export const LOGS_DIR = join(STATE_DIR, "jobs");

export interface PersistedJob {
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
  pid?: number;
}

export function ensureStateDirs(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
}

export function loadPersistedJobs(): PersistedJob[] {
  if (!existsSync(JOBS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(JOBS_FILE, "utf-8")) as PersistedJob[];
  } catch {
    return [];
  }
}

export function savePersistedJobs(jobs: PersistedJob[]): void {
  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2), "utf-8");
}

export function appendLog(jobId: string, line: string): void {
  appendFileSync(join(LOGS_DIR, `${jobId}.log`), line + "\n", "utf-8");
}

export function readLogSync(jobId: string, offset: number): string[] {
  const p = join(LOGS_DIR, `${jobId}.log`);
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, "utf-8").split("\n").filter((l) => l.length > 0);
    return lines.slice(offset);
  } catch {
    return [];
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
