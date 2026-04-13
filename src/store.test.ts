import { describe, it, expect, afterEach } from "vitest";
import { JobStore, LearningsStore, LEARNINGS_COMPRESS_THRESHOLD, LEARNINGS_KEEP_RECENT } from "./store.js";
import type { JobRecord } from "./store.js";

// Restore namespace env vars after each test (test-setup.ts flushes Redis DB)
afterEach(() => {
  delete process.env.CC_AGENT_NAMESPACE;
  delete process.env.CWD;
});

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

describe("JobStore namespace isolation", () => {
  it("listJobs only returns jobs saved in the current namespace", async () => {
    const storeA = new JobStore();
    const storeB = new JobStore();

    // Save a job in namespace "alpha"
    process.env.CC_AGENT_NAMESPACE = "alpha";
    await storeA.saveJob(makeJob("job-alpha-1"));

    // Switch to namespace "beta" and save a different job
    process.env.CC_AGENT_NAMESPACE = "beta";
    await storeB.saveJob(makeJob("job-beta-1"));

    // List in namespace "alpha" — should only see alpha's job
    process.env.CC_AGENT_NAMESPACE = "alpha";
    const alphaJobs = await storeA.listJobs();
    const alphaIds = alphaJobs.map((j) => j.id);
    expect(alphaIds).toContain("job-alpha-1");
    expect(alphaIds).not.toContain("job-beta-1");

    // List in namespace "beta" — should only see beta's job
    process.env.CC_AGENT_NAMESPACE = "beta";
    const betaJobs = await storeB.listJobs();
    const betaIds = betaJobs.map((j) => j.id);
    expect(betaIds).toContain("job-beta-1");
    expect(betaIds).not.toContain("job-alpha-1");
  });

  it("getJob retrieves a job by ID regardless of namespace (global addressability)", async () => {
    const store = new JobStore();

    process.env.CC_AGENT_NAMESPACE = "ns-one";
    await store.saveJob(makeJob("job-global-1"));

    // Switch namespace — getJob should still find it by ID
    process.env.CC_AGENT_NAMESPACE = "ns-two";
    const found = await store.getJob("job-global-1");
    expect(found).not.toBeNull();
    expect(found?.id).toBe("job-global-1");
  });

  it("jobs saved in 'default' namespace are not visible in other namespaces", async () => {
    const store = new JobStore();

    // No namespace env var → defaults to "default"
    await store.saveJob(makeJob("job-default-1"));

    // Switch to a different namespace
    process.env.CC_AGENT_NAMESPACE = "other";
    const otherJobs = await store.listJobs();
    const otherIds = otherJobs.map((j) => j.id);
    expect(otherIds).not.toContain("job-default-1");
  });

  it("CWD env var is used as namespace fallback", async () => {
    const store = new JobStore();

    process.env.CWD = "/home/user/my-project";
    await store.saveJob(makeJob("job-cwd-1"));

    const jobs = await store.listJobs();
    const ids = jobs.map((j) => j.id);
    expect(ids).toContain("job-cwd-1");

    // Different CWD should not see the job
    process.env.CWD = "/home/user/other-project";
    const otherJobs = await store.listJobs();
    const otherIds = otherJobs.map((j) => j.id);
    expect(otherIds).not.toContain("job-cwd-1");
  });
});

describe("LearningsStore", () => {
  it("addLearning and getLearnings round-trip", async () => {
    const store = new LearningsStore();
    await store.addLearning("test-ns", "## LEARNINGS\n- What worked: tests\n");
    const learnings = await store.getLearnings("test-ns", 10);
    expect(learnings.length).toBe(1);
    expect(learnings[0]).toContain("What worked: tests");
  });

  it("getLearnings returns newest first", async () => {
    const store = new LearningsStore();
    await store.addLearning("ordered-ns", "first");
    await store.addLearning("ordered-ns", "second");
    const learnings = await store.getLearnings("ordered-ns", 10);
    expect(learnings[0]).toBe("second");
    expect(learnings[1]).toBe("first");
  });

  it("getLearnings respects limit", async () => {
    const store = new LearningsStore();
    for (let i = 0; i < 7; i++) {
      await store.addLearning("limit-ns", `learning-${i}`);
    }
    const learnings = await store.getLearnings("limit-ns", 3);
    expect(learnings.length).toBe(3);
  });

  it("clearLearnings removes all entries for namespace", async () => {
    const store = new LearningsStore();
    await store.addLearning("clear-ns", "something");
    await store.clearLearnings("clear-ns");
    const learnings = await store.getLearnings("clear-ns", 10);
    expect(learnings.length).toBe(0);
  });

  it("clearLearnings does not affect other namespaces", async () => {
    const store = new LearningsStore();
    await store.addLearning("keep-ns", "keep this");
    await store.addLearning("wipe-ns", "wipe this");
    await store.clearLearnings("wipe-ns");
    const kept = await store.getLearnings("keep-ns", 10);
    expect(kept.length).toBe(1);
  });

  it("getLearningsCount returns correct count", async () => {
    const store = new LearningsStore();
    expect(await store.getLearningsCount("count-ns")).toBe(0);
    await store.addLearning("count-ns", "a");
    await store.addLearning("count-ns", "b");
    expect(await store.getLearningsCount("count-ns")).toBe(2);
  });

  it("caps at 50 entries", async () => {
    const store = new LearningsStore();
    for (let i = 0; i < 55; i++) {
      await store.addLearning("cap-ns", `entry-${i}`);
    }
    const count = await store.getLearningsCount("cap-ns");
    expect(count).toBeLessThanOrEqual(50);
  });

  it("compressIfNeeded is a no-op without Redis (in-memory store)", async () => {
    const store = new LearningsStore();
    // Add fewer than threshold entries — no-op regardless
    for (let i = 0; i < LEARNINGS_COMPRESS_THRESHOLD - 1; i++) {
      await store.addLearning("compress-noop-ns", `entry-${i}`);
    }
    // Should not throw and should not change state
    await store.compressIfNeeded("compress-noop-ns");
    const count = await store.getLearningsCount("compress-noop-ns");
    expect(count).toBe(LEARNINGS_COMPRESS_THRESHOLD - 1);
  });

  it("compressIfNeeded is a no-op when count is below threshold", async () => {
    const store = new LearningsStore();
    await store.addLearning("compress-low-ns", "only entry");
    await store.compressIfNeeded("compress-low-ns");
    const learnings = await store.getLearnings("compress-low-ns", 10);
    // Entry should still be there, unchanged
    expect(learnings[0]).toBe("only entry");
  });

  it("LEARNINGS_COMPRESS_THRESHOLD and LEARNINGS_KEEP_RECENT are positive integers", () => {
    expect(LEARNINGS_COMPRESS_THRESHOLD).toBeGreaterThan(0);
    expect(LEARNINGS_KEEP_RECENT).toBeGreaterThan(0);
    expect(Number.isInteger(LEARNINGS_COMPRESS_THRESHOLD)).toBe(true);
    expect(Number.isInteger(LEARNINGS_KEEP_RECENT)).toBe(true);
  });
});
