import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { JobStore, LearningsStore, ProfileStore, PlanStore } from "./store.js";
import type { JobRecord, Profile, PlanRecord } from "./store.js";

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

});

// ─── JobStore — updateJob ─────────────────────────────────────────────────────

describe("JobStore.updateJob", () => {
  afterEach(() => {
    delete process.env.CC_AGENT_NAMESPACE;
  });

  it("merges partial fields into an existing job", async () => {
    const store = new JobStore();
    process.env.CC_AGENT_NAMESPACE = "update-ns";
    await store.saveJob(makeJob("upd-1"));

    await store.updateJob("upd-1", { status: "done", exitCode: 0 });

    const updated = await store.getJob("upd-1");
    expect(updated?.status).toBe("done");
    expect(updated?.exitCode).toBe(0);
    // Original fields survive
    expect(updated?.repoUrl).toBe("https://github.com/test/repo.git");
  });

  it("is a no-op when the job ID does not exist", async () => {
    const store = new JobStore();
    process.env.CC_AGENT_NAMESPACE = "update-ns";
    // Should not throw
    await expect(store.updateJob("nonexistent-id", { status: "done" })).resolves.toBeUndefined();
  });
});

// ─── JobStore — loadAll ───────────────────────────────────────────────────────

describe("JobStore.loadAll", () => {
  afterEach(() => {
    delete process.env.CC_AGENT_NAMESPACE;
  });

  it("returns jobs from the store when they exist", async () => {
    const store = new JobStore();
    process.env.CC_AGENT_NAMESPACE = "load-all-ns";
    await store.saveJob(makeJob("load-1"));
    await store.saveJob(makeJob("load-2"));

    const all = await store.loadAll();
    const ids = all.map((j) => j.id);
    expect(ids).toContain("load-1");
    expect(ids).toContain("load-2");
  });

  it("loaded jobs have recentTools and outputLineCount defaults", async () => {
    const store = new JobStore();
    process.env.CC_AGENT_NAMESPACE = "load-all-defaults";
    await store.saveJob(makeJob("def-1"));

    const all = await store.loadAll();
    const job = all.find((j) => j.id === "def-1");
    expect(job).toBeDefined();
    expect(Array.isArray(job?.recentTools)).toBe(true);
    expect(typeof job?.outputLineCount).toBe("number");
  });
});

// ─── ProfileStore ─────────────────────────────────────────────────────────────

function makeProfile(name: string): Profile {
  return {
    name,
    repoUrl: "https://github.com/test/repo.git",
    taskTemplate: "Fix {{issue}}",
    createdAt: new Date().toISOString(),
  };
}

describe("ProfileStore", () => {
  afterEach(() => {
    delete process.env.CC_AGENT_NAMESPACE;
  });

  it("saveProfile and getProfile round-trip", async () => {
    const store = new ProfileStore();
    const profile = makeProfile("my-profile");
    await store.saveProfile(profile);
    const got = await store.getProfile("my-profile");
    expect(got).not.toBeNull();
    expect(got?.name).toBe("my-profile");
    expect(got?.taskTemplate).toBe("Fix {{issue}}");
  });

  it("getProfile returns null for non-existent name", async () => {
    const store = new ProfileStore();
    const got = await store.getProfile("does-not-exist");
    expect(got).toBeNull();
  });

  it("listProfiles returns all saved profiles", async () => {
    const store = new ProfileStore();
    await store.saveProfile(makeProfile("alpha-profile"));
    await store.saveProfile(makeProfile("beta-profile"));
    const profiles = await store.listProfiles();
    const names = profiles.map((p) => p.name);
    expect(names).toContain("alpha-profile");
    expect(names).toContain("beta-profile");
  });

  it("saveProfile overwrites an existing profile with the same name", async () => {
    const store = new ProfileStore();
    await store.saveProfile({ ...makeProfile("upsert-me"), taskTemplate: "old template" });
    await store.saveProfile({ ...makeProfile("upsert-me"), taskTemplate: "new template" });
    const got = await store.getProfile("upsert-me");
    expect(got?.taskTemplate).toBe("new template");
  });

  it("deleteProfile removes a saved profile and returns true", async () => {
    const store = new ProfileStore();
    await store.saveProfile(makeProfile("delete-me"));
    const deleted = await store.deleteProfile("delete-me");
    expect(deleted).toBe(true);
    const got = await store.getProfile("delete-me");
    expect(got).toBeNull();
  });

  it("deleteProfile returns false for a non-existent profile", async () => {
    const store = new ProfileStore();
    const result = await store.deleteProfile("ghost-profile");
    expect(result).toBe(false);
  });

  it("deleteProfile does not affect other profiles", async () => {
    const store = new ProfileStore();
    await store.saveProfile(makeProfile("keep-me"));
    await store.saveProfile(makeProfile("remove-me"));
    await store.deleteProfile("remove-me");
    const profiles = await store.listProfiles();
    expect(profiles.map((p) => p.name)).toContain("keep-me");
    expect(profiles.map((p) => p.name)).not.toContain("remove-me");
  });
});

// ─── PlanStore ────────────────────────────────────────────────────────────────
// PlanStore has no disk fallback — it is best-effort metadata backed by Redis only.
// Round-trip tests use a mocked Redis to verify the Redis path without requiring
// a real Redis connection (which may not be available in all CI environments).

import * as redisModule from "./redis.js";

function makePlan(id: string): PlanRecord {
  return {
    id,
    goal: "Test goal",
    steps: [{ stepId: "step-1", jobId: "job-1", status: "done" }],
    createdAt: new Date().toISOString(),
  };
}

describe("PlanStore — no-Redis behavior", () => {
  it("getPlan returns null when Redis is unavailable (no disk fallback)", async () => {
    // In environments where Redis is not running, getPlan always returns null.
    // This tests the no-Redis branch and also serves as a null-guard for dependent code.
    const store = new PlanStore();
    const got = await store.getPlan("no-such-plan");
    expect(got).toBeNull();
  });

  it("savePlan does not throw when Redis is unavailable (best-effort no-op)", async () => {
    // PlanStore has no disk fallback — missing Redis is silently tolerated.
    const store = new PlanStore();
    await expect(store.savePlan(makePlan("any-plan-id"))).resolves.toBeUndefined();
  });
});

describe("PlanStore — mocked Redis round-trip", () => {
  let redisSpy: ReturnType<typeof vi.spyOn>;
  let mockRedisGet: ReturnType<typeof vi.fn>;
  let mockRedisSet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRedisGet = vi.fn();
    mockRedisSet = vi.fn().mockResolvedValue("OK");
    const mockRedis = { get: mockRedisGet, set: mockRedisSet };
    redisSpy = vi.spyOn(redisModule, "getRedis").mockReturnValue(mockRedis as any);
  });

  afterEach(() => {
    redisSpy.mockRestore();
  });

  it("savePlan calls redis.set with the correct key and JSON payload", async () => {
    const store = new PlanStore();
    const plan = makePlan("plan-abc");
    await store.savePlan(plan);
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    const [key, value] = mockRedisSet.mock.calls[0] as [string, string, ...unknown[]];
    expect(key).toContain("plan-abc");
    expect(JSON.parse(value)).toMatchObject({ id: "plan-abc", goal: "Test goal" });
  });

  it("getPlan returns parsed plan when Redis has data", async () => {
    const plan = makePlan("plan-xyz");
    mockRedisGet.mockResolvedValue(JSON.stringify(plan));
    const store = new PlanStore();
    const got = await store.getPlan("plan-xyz");
    expect(got).not.toBeNull();
    expect(got?.id).toBe("plan-xyz");
    expect(got?.goal).toBe("Test goal");
    expect(got?.steps).toHaveLength(1);
  });

  it("getPlan returns null when Redis returns null (key not found)", async () => {
    mockRedisGet.mockResolvedValue(null);
    const store = new PlanStore();
    const got = await store.getPlan("missing-plan");
    expect(got).toBeNull();
  });

  it("savePlan sets a TTL (EX parameter is present)", async () => {
    const store = new PlanStore();
    await store.savePlan(makePlan("ttl-plan"));
    const callArgs = mockRedisSet.mock.calls[0] as unknown[];
    // redis.set(key, value, "EX", seconds)
    expect(callArgs).toContain("EX");
    const exIdx = callArgs.indexOf("EX");
    expect(typeof callArgs[exIdx + 1]).toBe("number");
    expect(callArgs[exIdx + 1] as number).toBeGreaterThan(0);
  });
});
