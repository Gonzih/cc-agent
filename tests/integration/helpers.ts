/**
 * Shared helpers for integration tests.
 * Intentionally avoids importing from src/ to stay dependency-light.
 */

import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── Job record shape (mirrors JobRecord from src/store.ts) ──────────────────

export interface TestJobRecord {
  id: string;
  status: string;
  repoUrl: string;
  task: string;
  recentTools: string[];
  outputLineCount: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  exitCode?: number;
  dockerIsolation?: boolean;
  [key: string]: unknown;
}

// ─── Job factory ─────────────────────────────────────────────────────────────

/** Creates a minimal job record suitable for store tests. */
export function createTestJob(overrides: Partial<TestJobRecord> = {}): TestJobRecord {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    status: "pending",
    repoUrl: "https://github.com/Gonzih/cc-tg",
    task: "integration test task",
    recentTools: [],
    outputLineCount: 0,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Polling helper ───────────────────────────────────────────────────────────

/** Polls store.getJob every 2 s until status matches or timeout expires. */
export async function waitForStatus<T extends { status: string }>(
  store: { getJob(id: string): Promise<T | null> },
  jobId: string,
  targetStatus: string,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await store.getJob(jobId);
    if (record?.status === targetStatus) return record;
    await new Promise<void>((r) => setTimeout(r, 2000));
  }
  return null;
}

// ─── Skip helpers ─────────────────────────────────────────────────────────────

/** Skips the test if Docker is not available.  Returns true when skipped. */
export async function skipIfNoDocker(
  t: { skip(msg?: string): void },
): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 5000 });
    return false;
  } catch {
    t.skip("Docker not available — skipping Docker integration test");
    return true;
  }
}

/** Skips the test if Redis is not reachable at localhost:6379. Returns true when skipped. */
export function skipIfNoRedis(t: { skip(msg?: string): void }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "localhost", port: 6379 });
    const timer = setTimeout(() => {
      socket.destroy();
      t.skip("Redis not available at localhost:6379");
      resolve(true);
    }, 2000);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      t.skip("Redis not available at localhost:6379");
      resolve(true);
    });
  });
}

/** Skips the test if ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN is not set. Returns true when skipped. */
export function skipIfNoApiKey(t: { skip(msg?: string): void }): boolean {
  const hasKey =
    !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!hasKey) {
    t.skip("No Anthropic API key — skipping test requiring real Claude invocation");
    return true;
  }
  return false;
}

// ─── Redis output helper ──────────────────────────────────────────────────────

/** Reads output lines for a job directly from Redis (cca:job:{id}:output). */
export async function getJobOutputFromRedis(jobId: string): Promise<string[]> {
  const { Redis } = await import("ioredis");
  const client = new Redis({
    host: "localhost",
    port: 6379,
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  await client.connect();
  try {
    return await client.lrange(`cca:job:${jobId}:output`, 0, -1);
  } finally {
    client.disconnect();
  }
}
