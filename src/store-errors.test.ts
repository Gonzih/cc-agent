/**
 * store-errors.test.ts
 *
 * Tests Redis failure → in-memory fallback paths for JobStore and LearningsStore.
 * Uses a mock Redis that can be configured to throw per-test.
 *
 * Separate from store.test.ts (which uses real Redis) so the mock doesn't
 * interfere with integration-style tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockGetRedis, mockRedis } = vi.hoisted(() => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    sadd: vi.fn(),
    srem: vi.fn(),
    smembers: vi.fn(),
    pipeline: vi.fn(),
    rpush: vi.fn(),
    expire: vi.fn(),
    lrange: vi.fn(),
    lpush: vi.fn(),
    ltrim: vi.fn(),
    del: vi.fn(),
    llen: vi.fn(),
  };
  return {
    mockGetRedis: vi.fn(() => mockRedis as typeof mockRedis | null),
    mockRedis,
  };
});

vi.mock("./redis.js", () => ({ getRedis: mockGetRedis }));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./namespace.js", () => ({
  getNamespace: vi.fn(() => "test-ns"),
  jobIndexKey: vi.fn(() => "cca:jobs:test-ns"),
}));

vi.mock("./state.js", () => ({
  loadPersistedJobs: vi.fn(() => []),
  savePersistedJobs: vi.fn(),
  appendLog: vi.fn(),
  readLogSync: vi.fn(() => []),
}));

// Import after mocks are set up
import { JobStore, LearningsStore } from "./store.js";
import type { JobRecord } from "./store.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeJob(id: string): JobRecord {
  return {
    id,
    status: "running",
    repoUrl: "https://github.com/test/repo.git",
    task: "test task",
    recentTools: [],
    outputLineCount: 0,
  };
}

function redisError(): Error {
  return new Error("Redis connection refused");
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: Redis is available but all methods return sensible defaults
  mockGetRedis.mockReturnValue(mockRedis);
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue("OK");
  mockRedis.sadd.mockResolvedValue(1);
  mockRedis.srem.mockResolvedValue(1);
  mockRedis.smembers.mockResolvedValue([]);
  mockRedis.rpush.mockResolvedValue(1);
  mockRedis.expire.mockResolvedValue(1);
  mockRedis.lrange.mockResolvedValue([]);
  mockRedis.lpush.mockResolvedValue(1);
  mockRedis.ltrim.mockResolvedValue("OK");
  mockRedis.del.mockResolvedValue(1);
  mockRedis.llen.mockResolvedValue(0);
  mockRedis.pipeline.mockReturnValue({
    get: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  });
});

// ─── JobStore — Redis failure → in-memory fallback ───────────────────────────

describe("JobStore - Redis failure fallback", () => {
  it("saveJob falls back to in-memory when Redis.set throws", async () => {
    mockRedis.set.mockRejectedValueOnce(redisError());
    mockRedis.sadd.mockRejectedValueOnce(redisError());

    const store = new JobStore();
    await store.saveJob(makeJob("job-fallback-1"));

    // Redis not available now — getJob should find it in memory
    mockGetRedis.mockReturnValueOnce(null);
    const found = await store.getJob("job-fallback-1");
    expect(found).not.toBeNull();
    expect(found?.id).toBe("job-fallback-1");
  });

  it("getJob falls back to in-memory when Redis.get throws", async () => {
    // Save to memory first (Redis.set throws)
    mockRedis.set.mockRejectedValueOnce(redisError());
    const store = new JobStore();
    await store.saveJob(makeJob("mem-job-2"));

    // Now getJob has Redis available but get() throws
    mockRedis.get.mockRejectedValueOnce(redisError());
    const found = await store.getJob("mem-job-2");
    expect(found?.id).toBe("mem-job-2");
  });

  it("getJob returns null for unknown id when Redis throws", async () => {
    mockRedis.get.mockRejectedValueOnce(redisError());
    const store = new JobStore();
    const found = await store.getJob("does-not-exist");
    expect(found).toBeNull();
  });

  it("listJobs falls back to in-memory when Redis.smembers throws", async () => {
    // Save job to memory
    mockRedis.set.mockRejectedValueOnce(redisError());
    const store = new JobStore();
    await store.saveJob(makeJob("list-fallback-job"));

    // smembers throws
    mockRedis.smembers.mockRejectedValueOnce(redisError());
    const jobs = await store.listJobs();
    expect(jobs.some((j) => j.id === "list-fallback-job")).toBe(true);
  });

  it("listJobs handles corrupted JSON entries in pipeline results gracefully", async () => {
    mockRedis.smembers.mockResolvedValueOnce(["job-ok", "job-corrupt"]);
    const validJson = JSON.stringify({
      id: "job-ok",
      status: "done",
      repoUrl: "https://github.com/test/r.git",
      task: "t",
      recentTools: [],
      outputLineCount: 0,
    } satisfies JobRecord);
    const mockPipeline = {
      get: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValueOnce([
        [null, validJson],
        [null, "INVALID_JSON{{{{"],
      ]),
    };
    mockRedis.pipeline.mockReturnValueOnce(mockPipeline);

    const store = new JobStore();
    const jobs = await store.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("job-ok");
  });

  it("listJobs returns empty array when pipeline returns null results", async () => {
    mockRedis.smembers.mockResolvedValueOnce(["job-a"]);
    const mockPipeline = {
      get: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValueOnce([[null, null]]),
    };
    mockRedis.pipeline.mockReturnValueOnce(mockPipeline);

    const store = new JobStore();
    const jobs = await store.listJobs();
    expect(jobs).toHaveLength(0);
  });

  it("listJobs returns empty array when smembers returns empty list", async () => {
    mockRedis.smembers.mockResolvedValueOnce([]);
    const store = new JobStore();
    const jobs = await store.listJobs();
    expect(jobs).toHaveLength(0);
  });

  it("updateJob is a no-op when job does not exist", async () => {
    mockRedis.get.mockResolvedValueOnce(null); // getJob returns null
    const store = new JobStore();
    // Should not throw — just silently does nothing
    await expect(store.updateJob("nonexistent", { status: "done" })).resolves.toBeUndefined();
  });

  it("appendOutput falls back to appendLog when Redis.rpush throws", async () => {
    const { appendLog } = await import("./state.js");
    mockRedis.rpush.mockRejectedValueOnce(redisError());

    const store = new JobStore();
    await store.appendOutput("job-x", "output line");
    expect(vi.mocked(appendLog)).toHaveBeenCalledWith("job-x", "output line");
  });

  it("getOutput falls back to readLogSync when Redis.lrange throws", async () => {
    const { readLogSync } = await import("./state.js");
    vi.mocked(readLogSync).mockReturnValueOnce(["cached-line"]);
    mockRedis.lrange.mockRejectedValueOnce(redisError());

    const store = new JobStore();
    const output = await store.getOutput("job-y", 0);
    expect(output).toEqual(["cached-line"]);
  });

  it("getOutput falls back to readLogSync when Redis is unavailable", async () => {
    const { readLogSync } = await import("./state.js");
    vi.mocked(readLogSync).mockReturnValueOnce(["disk-line"]);
    mockGetRedis.mockReturnValueOnce(null);

    const store = new JobStore();
    const output = await store.getOutput("job-z", 5);
    expect(vi.mocked(readLogSync)).toHaveBeenCalledWith("job-z", 5);
    expect(output).toEqual(["disk-line"]);
  });
});

// ─── LearningsStore — Redis failure → in-memory fallback ─────────────────────

describe("LearningsStore - Redis failure fallback", () => {
  it("addLearning falls back to in-memory when Redis.lpush throws", async () => {
    mockRedis.lpush.mockRejectedValueOnce(redisError());

    const store = new LearningsStore();
    await store.addLearning("err-ns", "learned something");

    // getLearnings also uses Redis — make it fall back too
    mockRedis.lrange.mockRejectedValueOnce(redisError());
    const results = await store.getLearnings("err-ns", 10);
    expect(results).toContain("learned something");
  });

  it("getLearnings falls back to in-memory when Redis.lrange throws", async () => {
    mockRedis.lpush.mockRejectedValueOnce(redisError());
    const store = new LearningsStore();
    await store.addLearning("lr-ns", "in-memory learning");

    mockRedis.lrange.mockRejectedValueOnce(redisError());
    const results = await store.getLearnings("lr-ns", 10);
    expect(results).toContain("in-memory learning");
  });

  it("clearLearnings falls back to in-memory when Redis.del throws", async () => {
    mockRedis.lpush.mockRejectedValueOnce(redisError());
    const store = new LearningsStore();
    await store.addLearning("cl-ns", "to clear");

    mockRedis.del.mockRejectedValueOnce(redisError());
    await store.clearLearnings("cl-ns");

    mockRedis.lrange.mockRejectedValueOnce(redisError());
    const results = await store.getLearnings("cl-ns", 10);
    expect(results).toHaveLength(0);
  });

  it("getLearningsCount falls back to in-memory when Redis.llen throws", async () => {
    mockRedis.lpush.mockRejectedValueOnce(redisError());
    const store = new LearningsStore();
    await store.addLearning("cnt-ns", "entry");

    mockRedis.llen.mockRejectedValueOnce(redisError());
    const count = await store.getLearningsCount("cnt-ns");
    expect(count).toBe(1);
  });

  it("clearLearnings is a no-op for unknown namespace (in-memory)", async () => {
    const store = new LearningsStore();
    mockGetRedis.mockReturnValueOnce(null);
    // clearing a namespace that was never written should not throw
    await expect(store.clearLearnings("unknown-ns")).resolves.toBeUndefined();
  });

  it("getLearnings returns empty array for unknown namespace (in-memory fallback)", async () => {
    mockGetRedis.mockReturnValueOnce(null);
    const store = new LearningsStore();
    const results = await store.getLearnings("new-ns", 10);
    expect(results).toEqual([]);
  });

  it("getLearningsCount returns 0 for unknown namespace (in-memory fallback)", async () => {
    mockGetRedis.mockReturnValueOnce(null);
    const store = new LearningsStore();
    const count = await store.getLearningsCount("new-ns");
    expect(count).toBe(0);
  });

  it("in-memory addLearning caps at 50 entries when Redis is unavailable", async () => {
    mockGetRedis.mockReturnValue(null); // Redis always unavailable for this test

    const store = new LearningsStore();
    for (let i = 0; i < 55; i++) {
      await store.addLearning("cap-mem-ns", `entry-${i}`);
    }

    const count = await store.getLearningsCount("cap-mem-ns");
    expect(count).toBeLessThanOrEqual(50);
  });

  it("in-memory getLearnings respects limit parameter", async () => {
    mockGetRedis.mockReturnValue(null);

    const store = new LearningsStore();
    for (let i = 0; i < 10; i++) {
      await store.addLearning("limit-mem-ns", `entry-${i}`);
    }

    const results = await store.getLearnings("limit-mem-ns", 3);
    expect(results).toHaveLength(3);
  });

  it("different namespaces are isolated in in-memory store", async () => {
    mockGetRedis.mockReturnValue(null);

    const store = new LearningsStore();
    await store.addLearning("ns-alpha", "alpha learning");
    await store.addLearning("ns-beta", "beta learning");

    const alphaResults = await store.getLearnings("ns-alpha", 10);
    const betaResults = await store.getLearnings("ns-beta", 10);

    expect(alphaResults).toContain("alpha learning");
    expect(alphaResults).not.toContain("beta learning");
    expect(betaResults).toContain("beta learning");
    expect(betaResults).not.toContain("alpha learning");
  });
});
