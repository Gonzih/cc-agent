import { describe, it, expect, afterEach } from "vitest";
import { JobStore } from "./store.js";
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
