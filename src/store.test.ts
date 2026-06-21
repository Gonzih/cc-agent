import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { JobStore, LearningsStore, ProfileStore, PlanStore } from "./store.js";
import type { JobRecord, Profile, PlanRecord } from "./store.js";
import { initRedis, getRedis } from "./redis.js";
import { ensureStateDirs } from "./state.js";
import { randomUUID } from "crypto";

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

// ─── JobStore — output and update paths ──────────────────────────────────────
//
// Use randomUUID() for job IDs so disk log files don't accumulate across
// test runs (appendLog writes to ~/.cc-agent/jobs/{id}.log on disk).

describe("JobStore — appendOutput / getOutput", () => {
  beforeAll(() => {
    ensureStateDirs();
  });

  function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
    return {
      id: randomUUID(),          // unique per test run to avoid disk state pollution
      status: "running",
      repoUrl: "https://github.com/test/repo.git",
      task: "test task",
      recentTools: [],
      outputLineCount: 0,
      ...overrides,
    };
  }

  it("appendOutput and getOutput round-trip (offset=0)", async () => {
    const store = new JobStore();
    const job = makeJob();
    await store.saveJob(job);

    await store.appendOutput(job.id, "line A");
    await store.appendOutput(job.id, "line B");
    await store.appendOutput(job.id, "line C");

    const lines = await store.getOutput(job.id, 0);
    expect(lines).toEqual(["line A", "line B", "line C"]);
  });

  it("getOutput with offset returns only lines after the offset", async () => {
    const store = new JobStore();
    const job = makeJob();
    await store.saveJob(job);

    for (const l of ["l0", "l1", "l2", "l3"]) {
      await store.appendOutput(job.id, l);
    }

    const tail = await store.getOutput(job.id, 2);
    expect(tail).toEqual(["l2", "l3"]);
  });

  it("getOutput from unknown job returns empty array", async () => {
    const store = new JobStore();
    const lines = await store.getOutput(`no-such-job-${randomUUID()}`, 0);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBe(0);
  });

  it("updateJob merges partial fields without losing others", async () => {
    const store = new JobStore();
    const job = makeJob();
    await store.saveJob(job);

    await store.updateJob(job.id, { status: "done", exitCode: 0 });
    const updated = await store.getJob(job.id);

    expect(updated?.status).toBe("done");
    expect(updated?.exitCode).toBe(0);
    // Original fields are preserved
    expect(updated?.repoUrl).toBe(job.repoUrl);
    expect(updated?.task).toBe(job.task);
  });

  it("updateJob on a non-existent id is a no-op (no error thrown)", async () => {
    const store = new JobStore();
    await expect(store.updateJob(`ghost-${randomUUID()}`, { status: "done" })).resolves.not.toThrow();
  });

  it("saveJob then getJob returns the saved record", async () => {
    const store = new JobStore();
    const job = makeJob();
    await store.saveJob(job);

    const found = await store.getJob(job.id);
    expect(found?.id).toBe(job.id);
    expect(found?.status).toBe("running");
  });
});

// ─── ProfileStore ─────────────────────────────────────────────────────────────

describe("ProfileStore", () => {
  function makeProfile(name: string, extra: Partial<Profile> = {}): Profile {
    return {
      name,
      repoUrl: "https://github.com/example/repo.git",
      taskTemplate: "Run {{action}}",
      createdAt: new Date().toISOString(),
      ...extra,
    };
  }

  it("saveProfile and getProfile round-trip", async () => {
    const store = new ProfileStore();
    const profile = makeProfile("my-profile");
    await store.saveProfile(profile);

    const found = await store.getProfile("my-profile");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("my-profile");
    expect(found?.repoUrl).toBe("https://github.com/example/repo.git");
  });

  it("getProfile returns null for unknown name", async () => {
    const store = new ProfileStore();
    const found = await store.getProfile("profile-that-does-not-exist");
    expect(found).toBeNull();
  });

  it("saveProfile overwrites existing profile with same name", async () => {
    const store = new ProfileStore();
    await store.saveProfile(makeProfile("overwrite-me", { taskTemplate: "first" }));
    await store.saveProfile(makeProfile("overwrite-me", { taskTemplate: "second" }));

    const found = await store.getProfile("overwrite-me");
    expect(found?.taskTemplate).toBe("second");
  });

  it("listProfiles returns all saved profiles", async () => {
    const store = new ProfileStore();
    await store.saveProfile(makeProfile("list-prof-a"));
    await store.saveProfile(makeProfile("list-prof-b"));

    const profiles = await store.listProfiles();
    const names = profiles.map((p) => p.name);
    expect(names).toContain("list-prof-a");
    expect(names).toContain("list-prof-b");
  });

  it("deleteProfile returns true for an existing profile", async () => {
    const store = new ProfileStore();
    await store.saveProfile(makeProfile("delete-me"));
    const deleted = await store.deleteProfile("delete-me");
    expect(deleted).toBe(true);
  });

  it("deleteProfile returns false for a non-existent profile", async () => {
    const store = new ProfileStore();
    const deleted = await store.deleteProfile("no-such-profile-xyz");
    expect(deleted).toBe(false);
  });

  it("deleted profile is not returned by getProfile", async () => {
    const store = new ProfileStore();
    await store.saveProfile(makeProfile("ephemeral-p"));
    await store.deleteProfile("ephemeral-p");

    const found = await store.getProfile("ephemeral-p");
    expect(found).toBeNull();
  });

  it("deleted profile is not returned by listProfiles", async () => {
    const store = new ProfileStore();
    await store.saveProfile(makeProfile("will-be-gone"));
    await store.deleteProfile("will-be-gone");

    const profiles = await store.listProfiles();
    expect(profiles.some((p) => p.name === "will-be-gone")).toBe(false);
  });

  it("deleteProfile of already-deleted profile returns false", async () => {
    const store = new ProfileStore();
    await store.saveProfile(makeProfile("once-only"));
    await store.deleteProfile("once-only");
    const secondDelete = await store.deleteProfile("once-only");
    expect(secondDelete).toBe(false);
  });

  it("stores optional fields (description, defaultBudgetUsd)", async () => {
    const store = new ProfileStore();
    await store.saveProfile(makeProfile("with-extras", {
      description: "A test profile",
      defaultBudgetUsd: 5.0,
    }));

    const found = await store.getProfile("with-extras");
    expect(found?.description).toBe("A test profile");
    expect(found?.defaultBudgetUsd).toBe(5.0);
  });
});

// ─── PlanStore ────────────────────────────────────────────────────────────────
//
// PlanStore is Redis-only (no in-memory or disk fallback — plans are
// intentionally best-effort metadata). Round-trip tests are skipped when
// Redis is unavailable; the no-op / null-return behavior is always tested.

describe("PlanStore", () => {
  // PlanStore is Redis-only (no in-memory or disk fallback).
  // Round-trip tests are skipped at runtime when Redis is unavailable.

  beforeAll(async () => {
    await initRedis().catch(() => {});
  });

  const redisReady = () => !!getRedis();

  function makePlan(id: string): PlanRecord {
    return {
      id,
      goal: "Deploy the service",
      steps: [
        { stepId: "s1", jobId: "job-111", status: "done" },
        { stepId: "s2", jobId: "job-222", status: "pending" },
      ],
      createdAt: new Date().toISOString(),
    };
  }

  it("getPlan returns null for unknown id regardless of Redis state", async () => {
    const store = new PlanStore();
    const found = await store.getPlan("plan-that-does-not-exist-xyz");
    expect(found).toBeNull();
  });

  it("savePlan does not throw even when Redis is unavailable (best-effort)", async () => {
    const store = new PlanStore();
    await expect(store.savePlan(makePlan("no-throw-test"))).resolves.not.toThrow();
  });

  it("savePlan and getPlan round-trip (requires Redis)", async () => {
    if (!redisReady()) return; // skip: PlanStore has no in-memory fallback
    const store = new PlanStore();
    const plan = makePlan("plan-round-trip");
    await store.savePlan(plan);

    const found = await store.getPlan("plan-round-trip");
    expect(found).not.toBeNull();
    expect(found?.id).toBe("plan-round-trip");
    expect(found?.goal).toBe("Deploy the service");
  });

  it("savePlan persists the steps array (requires Redis)", async () => {
    if (!redisReady()) return;
    const store = new PlanStore();
    const plan = makePlan("plan-with-steps");
    await store.savePlan(plan);

    const found = await store.getPlan("plan-with-steps");
    expect(found?.steps).toHaveLength(2);
    expect(found?.steps[0].stepId).toBe("s1");
    expect(found?.steps[1].jobId).toBe("job-222");
  });

  it("savePlan overwrites an existing plan with the same id (requires Redis)", async () => {
    if (!redisReady()) return;
    const store = new PlanStore();
    await store.savePlan({ ...makePlan("plan-overwrite"), goal: "first goal" });
    await store.savePlan({ ...makePlan("plan-overwrite"), goal: "second goal" });

    const found = await store.getPlan("plan-overwrite");
    expect(found?.goal).toBe("second goal");
  });

  it("multiple distinct plans are retrievable independently (requires Redis)", async () => {
    if (!redisReady()) return;
    const store = new PlanStore();
    await store.savePlan(makePlan("plan-x"));
    await store.savePlan(makePlan("plan-y"));

    const x = await store.getPlan("plan-x");
    const y = await store.getPlan("plan-y");

    expect(x?.id).toBe("plan-x");
    expect(y?.id).toBe("plan-y");
  });
});
