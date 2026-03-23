import { describe, it, expect, vi, beforeEach } from "vitest";
import { injectPreamble, DEFAULT_PREAMBLE } from "./preamble.js";

const { mockIsPidAlive, mockJobStoreLoadAll } = vi.hoisted(() => ({
  mockIsPidAlive: vi.fn(() => false),
  mockJobStoreLoadAll: vi.fn(async () => [] as any[]),
}));

vi.mock("./state.js", () => ({
  ensureStateDirs: vi.fn(),
  loadPersistedJobs: vi.fn(() => []),
  savePersistedJobs: vi.fn(),
  appendLog: vi.fn(),
  readLogSync: vi.fn(() => []),
  isPidAlive: mockIsPidAlive,
}));

vi.mock("./store.js", () => ({
  jobStore: {
    loadAll: mockJobStoreLoadAll,
    saveJob: vi.fn(async () => {}),
    updateJob: vi.fn(async () => {}),
    getJob: vi.fn(async () => null),
    listJobs: vi.fn(async () => []),
    appendOutput: vi.fn(async () => {}),
    getOutput: vi.fn(async () => []),
  },
  profileStore: {},
  planStore: { savePlan: vi.fn(async () => {}) },
}));

vi.mock("./redis.js", () => ({ getRedis: vi.fn(() => null) }));

vi.mock("child_process", async () => {
  return {
    execFile: vi.fn(
      (
        _cmd: string,
        _args: string[],
        optsOrCb: unknown,
        cb?: (err: null, stdout: string, stderr: string) => void
      ) => {
        const callback =
          typeof optsOrCb === "function"
            ? (optsOrCb as Function)
            : cb!;
        callback(null, "", "");
      }
    ),
  };
});

vi.mock("fs/promises", async () => ({
  mkdtemp: vi.fn(() => Promise.resolve("/tmp/test-workdir")),
  rm: vi.fn(() => Promise.resolve()),
}));

vi.mock("./claude.js", async () => {
  const { EventEmitter } = await import("events");
  return {
    runClaude: vi.fn(() => {
      const emitter = new EventEmitter() as any;
      emitter.kill = vi.fn();
      emitter.pid = 12345;
      emitter.stdin = null;
      setTimeout(() => emitter.emit("exit", 0), 50);
      return emitter;
    }),
  };
});

// Import after mocks are in place
import { JobManager } from "./agent.js";

describe("injectPreamble", () => {
  it("prepends the default preamble to the task", () => {
    const result = injectPreamble("do the thing");
    expect(result).toBe(DEFAULT_PREAMBLE + "do the thing");
  });

  it("prepends a custom preamble when provided", () => {
    const result = injectPreamble("do the thing", "## custom\n\n");
    expect(result).toBe("## custom\n\ndo the thing");
  });

  it("uses default preamble when customPreamble is undefined", () => {
    const result = injectPreamble("task", undefined);
    expect(result.startsWith(DEFAULT_PREAMBLE)).toBe(true);
  });

  it("DEFAULT_PREAMBLE contains the workflow rules", () => {
    expect(DEFAULT_PREAMBLE).toContain("cc-agent workflow");
    expect(DEFAULT_PREAMBLE).toContain("NEVER work directly on main");
    expect(DEFAULT_PREAMBLE).toContain("gh pr create");
  });
});

describe("JobManager", () => {
  let manager: JobManager;

  beforeEach(() => {
    manager = new JobManager();
  });

  it("constructor creates empty jobs map", () => {
    expect(manager.list()).toEqual([]);
  });

  it("spawn() returns a job ID string", async () => {
    const id = await manager.spawn({
      repoUrl: "https://github.com/test/repo.git",
      task: "Write tests",
    });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("getJob() returns the job after spawn", async () => {
    const id = await manager.spawn({
      repoUrl: "https://github.com/test/repo.git",
      task: "Write tests",
    });
    const job = manager.getJob(id);
    expect(job).toBeDefined();
    expect(job!.id).toBe(id);
    expect(job!.task).toBe("Write tests");
    expect(job!.repoUrl).toBe("https://github.com/test/repo.git");
  });

  it("list() returns all jobs with truncated task", async () => {
    const longTask = "a".repeat(200);
    await manager.spawn({
      repoUrl: "https://github.com/test/repo.git",
      task: longTask,
    });
    const list = manager.list();
    expect(list.length).toBe(1);
    expect(list[0].task.length).toBeLessThanOrEqual(123); // 120 + "..."
    expect(list[0].task.endsWith("...")).toBe(true);
  });

  it("list() returns short task without truncation", async () => {
    await manager.spawn({
      repoUrl: "https://github.com/test/repo.git",
      task: "short task",
    });
    const list = manager.list();
    expect(list[0].task).toBe("short task");
  });

  it("getJob() returns undefined for unknown id", () => {
    expect(manager.getJob("unknown-id")).toBeUndefined();
  });

  it("cancel() returns false for unknown job", () => {
    expect(manager.cancel("not-a-real-id")).toBe(false);
  });

  it("cancel() returns true for cloning job and changes status to cancelled", async () => {
    const id = await manager.spawn({
      repoUrl: "https://github.com/test/repo.git",
      task: "Write tests",
    });
    const result = manager.cancel(id);
    expect(result).toBe(true);
    const job = manager.getJob(id);
    expect(job!.status).toBe("cancelled");
  });

  it("getOutput() returns initial output lines", async () => {
    const id = await manager.spawn({
      repoUrl: "https://github.com/test/repo.git",
      task: "Write tests",
    });
    const { lines, toolCalls } = await manager.getOutput(id, 0);
    expect(Array.isArray(lines)).toBe(true);
    expect(Array.isArray(toolCalls)).toBe(true);
  });

  it("getOutput() returns disk log for unknown id", async () => {
    const { lines, done } = await manager.getOutput("nonexistent-id", 0);
    expect(lines).toEqual([]);
    expect(done).toBe(true);
  });

  it("sendMessage() returns error for unknown job", () => {
    const result = manager.sendMessage("bad-id", "hello");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it("wakeJob() returns error for unknown job", async () => {
    const result = await manager.wakeJob("nonexistent-id");
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/not found/i);
  });

  it("wakeJob() returns error when job is not sleeping", async () => {
    const id = await manager.spawn({
      repoUrl: "https://github.com/test/repo.git",
      task: "Write tests",
    });
    const result = await manager.wakeJob(id);
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/not sleeping/i);
  });

  it("sendMessage() returns error for non-running job (cloning state)", async () => {
    const id = await manager.spawn({
      repoUrl: "https://github.com/test/repo.git",
      task: "Write tests",
    });
    // Job starts in 'cloning' status
    const job = manager.getJob(id);
    expect(job!.status).toBe("cloning");
    const result = manager.sendMessage(id, "hello");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not running/i);
  });
});

describe("JobManager.init() — PID reconciliation on restart", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIsPidAlive.mockReturnValue(false);
  });

  it("leaves a running job with no stored PID as running (cannot verify)", async () => {
    mockJobStoreLoadAll.mockResolvedValue([{
      id: "job-no-pid",
      status: "running",
      repoUrl: "https://github.com/test/repo.git",
      task: "some task",
      startedAt: new Date().toISOString(),
      recentTools: [],
      outputLineCount: 0,
      // pid intentionally absent
    }]);
    const m = new JobManager();
    await m.init();
    const job = m.getJob("job-no-pid");
    expect(job?.status).toBe("running");
  });

  it("marks a running job with a dead PID as failed", async () => {
    mockIsPidAlive.mockReturnValue(false);
    mockJobStoreLoadAll.mockResolvedValue([{
      id: "job-dead-pid",
      status: "running",
      repoUrl: "https://github.com/test/repo.git",
      task: "some task",
      startedAt: new Date().toISOString(),
      pid: 99999,
      recentTools: [],
      outputLineCount: 0,
    }]);
    const m = new JobManager();
    await m.init();
    const job = m.getJob("job-dead-pid");
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(/Process not found after restart/);
  });

  it("keeps a running job with an alive PID as running", async () => {
    mockIsPidAlive.mockReturnValue(true);
    mockJobStoreLoadAll.mockResolvedValue([{
      id: "job-alive-pid",
      status: "running",
      repoUrl: "https://github.com/test/repo.git",
      task: "some task",
      startedAt: new Date().toISOString(),
      pid: 12345,
      recentTools: [],
      outputLineCount: 0,
    }]);
    const m = new JobManager();
    await m.init();
    const job = m.getJob("job-alive-pid");
    expect(job?.status).toBe("running");
    expect(job?.error).toBeUndefined();
  });
});
