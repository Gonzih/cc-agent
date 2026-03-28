/**
 * Job state-machine and persistence integration tests.
 *
 * Tests the JobStore directly (save / get / update / output) to verify
 * the full persistence pipeline — Redis when available, in-memory otherwise.
 *
 * Run via: npm run test:integration
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestJob, getJobOutputFromRedis } from "./helpers.js";
import { JobStore } from "../../src/store.js";
import { initRedis, getRedis } from "../../src/redis.js";
import { jobIndexKey } from "../../src/namespace.js";
import { ensureStateDirs } from "../../src/state.js";

// ─── In-memory store operations (no Redis required) ───────────────────────────

describe("JobStore — in-memory operations", () => {
  // Ensure the .cc-agent/jobs/ directory exists for disk-fallback output.
  before(() => ensureStateDirs());

  // Each test uses its own store instance to stay isolated.

  test("save and retrieve a job record", async () => {
    const store = new JobStore();
    const job = createTestJob({ status: "pending" });
    await store.saveJob(job);

    const retrieved = await store.getJob(job.id);
    assert.ok(retrieved, "Job should be retrievable after saving");
    assert.equal(retrieved.id, job.id);
    assert.equal(retrieved.status, "pending");
    assert.equal(retrieved.repoUrl, job.repoUrl);
  });

  test("updateJob transitions status field", async () => {
    const store = new JobStore();
    const job = createTestJob({ status: "pending" });
    await store.saveJob(job);

    await store.updateJob(job.id, { status: "running" });
    const updated = await store.getJob(job.id);
    assert.equal(updated?.status, "running");
  });

  test("job goes pending → cloning → running → done", async () => {
    const store = new JobStore();
    const job = createTestJob({ status: "pending" });
    await store.saveJob(job);

    for (const status of ["cloning", "running", "done"] as const) {
      await store.updateJob(job.id, { status });
      const record = await store.getJob(job.id);
      assert.equal(record?.status, status, `Expected status ${status}`);
    }
  });

  test("finishedAt is set when job completes", async () => {
    const store = new JobStore();
    const job = createTestJob({ status: "running" });
    await store.saveJob(job);

    const finishedAt = new Date().toISOString();
    await store.updateJob(job.id, { status: "done", finishedAt });
    const record = await store.getJob(job.id);

    assert.equal(record?.status, "done");
    assert.ok(record?.finishedAt, "finishedAt should be set on completion");
    assert.equal(record.finishedAt, finishedAt);
  });

  test("failed job preserves status=failed and error message", async () => {
    const store = new JobStore();
    const job = createTestJob({ status: "running" });
    await store.saveJob(job);

    const errorMsg = "claude exited with code 1: permission denied";
    await store.updateJob(job.id, {
      status: "failed",
      error: errorMsg,
      exitCode: 1,
      finishedAt: new Date().toISOString(),
    });

    const record = await store.getJob(job.id);
    assert.equal(record?.status, "failed");
    assert.equal(record?.error, errorMsg);
    assert.equal(record?.exitCode, 1);
  });

  test("output lines are appended and retrievable in order", async () => {
    const store = new JobStore();
    const job = createTestJob();
    await store.saveJob(job);

    const lines = [
      "cloning repo...",
      "running claude...",
      "AGENT_SCORE: 0.9",
      "done",
    ];

    for (const line of lines) {
      await store.appendOutput(job.id, line);
    }

    const output = await store.getOutput(job.id, 0);
    assert.deepEqual(output, lines);
  });

  test("getOutput with offset returns tail of output", async () => {
    const store = new JobStore();
    const job = createTestJob();
    await store.saveJob(job);

    for (const line of ["line0", "line1", "line2", "line3"]) {
      await store.appendOutput(job.id, line);
    }

    const tail = await store.getOutput(job.id, 2);
    assert.deepEqual(tail, ["line2", "line3"]);
  });

  test("listJobs returns all saved jobs", async () => {
    const store = new JobStore();
    const jobA = createTestJob({ task: "job-a" });
    const jobB = createTestJob({ task: "job-b" });
    await store.saveJob(jobA);
    await store.saveJob(jobB);

    const all = await store.listJobs();
    const ids = all.map((j) => j.id);
    assert.ok(ids.includes(jobA.id), "listJobs should include jobA");
    assert.ok(ids.includes(jobB.id), "listJobs should include jobB");
  });
});

// ─── Redis persistence tests (skip if Redis unavailable) ──────────────────────

describe("JobStore — Redis persistence", () => {
  let redisReady = false;

  // Try to connect to Redis once; all tests in this suite skip on failure.
  before(async () => {
    try {
      await initRedis();
      redisReady = !!getRedis();
    } catch {
      redisReady = false;
    }
  });

  after(async () => {
    const redis = getRedis();
    if (redis) {
      await redis.quit().catch(() => {});
    }
  });

  test("job is persisted to Redis key cca:job:{id}", async (t) => {
    if (!redisReady) {
      t.skip("Redis not available");
      return;
    }

    const store = new JobStore();
    const job = createTestJob({ status: "running" });
    await store.saveJob(job);

    // Verify directly in Redis
    const redis = getRedis()!;
    const raw = await redis.get(`cca:job:${job.id}`);
    assert.ok(raw, `Expected Redis key cca:job:${job.id} to exist`);

    const parsed = JSON.parse(raw);
    assert.equal(parsed.id, job.id);
    assert.equal(parsed.status, "running");
  });

  test("job id is added to namespace index set in Redis", async (t) => {
    if (!redisReady) {
      t.skip("Redis not available");
      return;
    }

    const store = new JobStore();
    const job = createTestJob();
    await store.saveJob(job);

    const redis = getRedis()!;
    // The index key pattern is cca:jobs:<namespace>
    const isMember = await redis.sismember(jobIndexKey(), job.id);
    assert.equal(isMember, 1, `Job ${job.id} should be in the namespace index`);
  });

  test("output lines are stored in Redis list cca:job:{id}:output", async (t) => {
    if (!redisReady) {
      t.skip("Redis not available");
      return;
    }

    const store = new JobStore();
    const job = createTestJob();
    await store.saveJob(job);

    await store.appendOutput(job.id, "first output line");
    await store.appendOutput(job.id, "second output line");

    // Verify directly in Redis
    const lines = await getJobOutputFromRedis(job.id);
    assert.deepEqual(lines, ["first output line", "second output line"]);
  });

  test("status transition is visible after Redis round-trip", async (t) => {
    if (!redisReady) {
      t.skip("Redis not available");
      return;
    }

    const store = new JobStore();
    const job = createTestJob({ status: "cloning" });
    await store.saveJob(job);

    // Simulate job progressing
    await store.updateJob(job.id, { status: "running" });
    await store.updateJob(job.id, {
      status: "done",
      finishedAt: new Date().toISOString(),
      exitCode: 0,
    });

    // Retrieve via a fresh store instance to force Redis read
    const store2 = new JobStore();
    const record = await store2.getJob(job.id);

    assert.equal(record?.status, "done");
    assert.ok(record?.finishedAt, "finishedAt should be persisted");
    assert.equal(record?.exitCode, 0);
  });
});
