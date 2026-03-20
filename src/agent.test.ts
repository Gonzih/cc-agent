import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./state.js", () => ({
  ensureStateDirs: vi.fn(),
  loadPersistedJobs: vi.fn(() => []),
  savePersistedJobs: vi.fn(),
  appendLog: vi.fn(),
  readLogSync: vi.fn(() => []),
  isPidAlive: vi.fn(() => false),
}));

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
    const { lines, toolCalls } = manager.getOutput(id, 0);
    expect(Array.isArray(lines)).toBe(true);
    expect(Array.isArray(toolCalls)).toBe(true);
  });

  it("getOutput() returns disk log for unknown id", () => {
    const { lines, done } = manager.getOutput("nonexistent-id", 0);
    expect(lines).toEqual([]);
    expect(done).toBe(true);
  });

  it("sendMessage() returns error for unknown job", () => {
    const result = manager.sendMessage("bad-id", "hello");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
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
