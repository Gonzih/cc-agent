import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runCompletionGate,
  runRealityGate,
  runQualityGate,
  buildQualityEvalTask,
  parseEvalOutput,
  computeOutputHash,
  runLoopGates,
  LOOP_MAX_ITERATIONS,
} from "./loop.js";
import type { Job, GateFailure } from "./types.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockExecFile } = vi.hoisted(() => {
  const mockExecFile = vi.fn();
  return { mockExecFile };
});

vi.mock("child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function promisify<T>(fn: vi.Mock): (...args: unknown[]) => Promise<T> {
  return (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      fn(...args, (err: Error | null, result: T) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "test-job-id",
    repoUrl: "https://github.com/test/repo",
    task: "Fix the bug",
    status: "running",
    output: ["line 1", "line 2"],
    toolCalls: [],
    startedAt: new Date(),
    agentDriver: "claude",
    completionCriteria: ["npm test"],
    goal: "All tests must pass",
    iteration: 1,
    gateFailures: [],
    retryCount: 0,
    maxIterations: 3,
    ...overrides,
  } as Job;
}

function makeManager(overrides: Partial<{
  spawn: vi.Mock;
  getJob: vi.Mock;
  cancel: vi.Mock;
}> = {}) {
  return {
    spawn: vi.fn(async () => "eval-job-id"),
    getJob: vi.fn(() => undefined as Job | undefined),
    cancel: vi.fn(),
    ...overrides,
  };
}

// ─── runCompletionGate ────────────────────────────────────────────────────────

describe("runCompletionGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes when all commands exit 0", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));
    const result = await runCompletionGate(["npm test", "echo ok"], "/tmp/work");
    expect(result.passed).toBe(true);
    expect(result.gate).toBe("completion");
  });

  it("fails on first non-zero exit", async () => {
    const err = Object.assign(new Error("exit 1"), { stdout: "", stderr: "Test failed: 3 failing" });
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(err, "", "Test failed: 3 failing"));
    const result = await runCompletionGate(["npm test"], "/tmp/work");
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("npm test");
    expect(result.reason).toContain("Test failed: 3 failing");
  });

  it("reports timeout when process killed", async () => {
    const err = Object.assign(new Error("killed"), { killed: true, stdout: "", stderr: "" });
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(err, "", ""));
    const result = await runCompletionGate(["npm test"], "/tmp/work");
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("timed out");
  });

  it("passes with empty criteria array", async () => {
    const result = await runCompletionGate([], "/tmp/work");
    expect(result.passed).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("runs multiple criteria and stops on first failure", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      callCount++;
      if (callCount === 1) cb(null, "", ""); // first passes
      else cb(Object.assign(new Error("fail"), { stdout: "", stderr: "compile error" }), "", "compile error");
    });
    const result = await runCompletionGate(["echo ok", "npm build", "npm test"], "/tmp/work");
    expect(result.passed).toBe(false);
    expect(callCount).toBe(2); // stopped at second command
  });
});

// ─── runRealityGate ───────────────────────────────────────────────────────────

describe("runRealityGate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes when no checkCmd defined", async () => {
    const result = await runRealityGate(undefined, "/tmp/work");
    expect(result.passed).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("passes when checkCmd exits 0", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));
    const result = await runRealityGate("npm run build", "/tmp/work");
    expect(result.passed).toBe(true);
  });

  it("fails when checkCmd exits non-zero", async () => {
    const err = Object.assign(new Error("fail"), { stdout: "", stderr: "compile error" });
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(err, "", "compile error"));
    const result = await runRealityGate("npm run build", "/tmp/work");
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("reality check failed");
  });

  it("reports timeout when process killed", async () => {
    const err = Object.assign(new Error("killed"), { killed: true, stdout: "", stderr: "" });
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(err, "", ""));
    const result = await runRealityGate("npm test", "/tmp/work");
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("timed out");
  });
});

// ─── parseEvalOutput ─────────────────────────────────────────────────────────

describe("parseEvalOutput", () => {
  it("parses a valid GATE_EVAL line", () => {
    const lines = [
      "Some text",
      'GATE_EVAL: {"gate":"quality","passed":false,"feedback":"Missing error handling in login function","confidence":0.9}',
    ];
    const result = parseEvalOutput(lines);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.feedback).toBe("Missing error handling in login function");
    expect(result!.confidence).toBe(0.9);
  });

  it("returns null when no GATE_EVAL line", () => {
    const result = parseEvalOutput(["no eval here", "just output"]);
    expect(result).toBeNull();
  });

  it("picks the LAST GATE_EVAL line in case of duplicates", () => {
    const lines = [
      'GATE_EVAL: {"gate":"quality","passed":true,"feedback":"ok","confidence":0.5}',
      'GATE_EVAL: {"gate":"quality","passed":false,"feedback":"actually wrong","confidence":0.8}',
    ];
    const result = parseEvalOutput(lines);
    expect(result!.passed).toBe(false);
    expect(result!.feedback).toBe("actually wrong");
  });

  it("clamps confidence to [0, 1]", () => {
    const lines = [
      'GATE_EVAL: {"gate":"quality","passed":true,"feedback":"ok","confidence":1.5}',
    ];
    const result = parseEvalOutput(lines);
    expect(result!.confidence).toBe(1);
  });

  it("defaults confidence to 0.5 when not a number", () => {
    const lines = [
      'GATE_EVAL: {"gate":"quality","passed":false,"feedback":"bad","confidence":"high"}',
    ];
    const result = parseEvalOutput(lines);
    expect(result!.confidence).toBe(0.5);
  });

  it("skips malformed JSON and keeps looking", () => {
    const lines = [
      "GATE_EVAL: not-json",
      'GATE_EVAL: {"gate":"quality","passed":true,"feedback":"good","confidence":0.7}',
    ];
    const result = parseEvalOutput(lines);
    expect(result!.passed).toBe(true);
  });
});

// ─── buildQualityEvalTask ─────────────────────────────────────────────────────

describe("buildQualityEvalTask", () => {
  it("includes goal, criteria, rubric, and worker output", () => {
    const task = buildQualityEvalTask({
      goal: "All tests must pass",
      completionCriteria: ["npm test", "npm run lint"],
      qualityRubric: "Code must have no TODO comments",
      workerOutputSnippet: "3 passing\n0 failing",
      workerJobId: "worker-123",
      iteration: 2,
    });
    expect(task).toContain("All tests must pass");
    expect(task).toContain("npm test");
    expect(task).toContain("npm run lint");
    expect(task).toContain("Code must have no TODO comments");
    expect(task).toContain("3 passing");
    expect(task).toContain("worker-123");
    expect(task).toContain("iteration 2");
    expect(task).toContain("GATE_EVAL:");
  });
});

// ─── computeOutputHash ────────────────────────────────────────────────────────

describe("computeOutputHash", () => {
  it("returns the same hash for the same output", () => {
    const lines = ["a", "b", "c"];
    expect(computeOutputHash(lines)).toBe(computeOutputHash(lines));
  });

  it("returns different hashes for different outputs", () => {
    expect(computeOutputHash(["a"])).not.toBe(computeOutputHash(["b"]));
  });

  it("uses only last 50 lines", () => {
    const manyLines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const last50 = manyLines.slice(-50);
    expect(computeOutputHash(manyLines)).toBe(computeOutputHash(last50));
  });
});

// ─── runQualityGate ──────────────────────────────────────────────────────────

describe("runQualityGate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes when no qualityRubric configured", async () => {
    const job = makeJob({ qualityRubric: undefined });
    const manager = makeManager();
    const result = await runQualityGate({ job, manager: manager as any, workerOutputLines: [] });
    expect(result.passed).toBe(true);
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("spawns eval agent with rubric and waits for output", async () => {
    const evalJob = makeJob({
      id: "eval-job-id",
      status: "done",
      output: ['GATE_EVAL: {"gate":"quality","passed":true,"feedback":"Looks good","confidence":0.9}'],
    });
    const manager = makeManager({
      getJob: vi.fn(() => evalJob),
    });
    const job = makeJob({ qualityRubric: "must have tests" });
    const result = await runQualityGate({ job, manager: manager as any, workerOutputLines: ["3 passing"] });
    expect(result.passed).toBe(true);
    expect(result.feedback).toBe("Looks good");
    expect(manager.spawn).toHaveBeenCalledOnce();
  });

  it("returns failed when eval agent says passed=false", async () => {
    const evalJob = makeJob({
      id: "eval-job-id",
      status: "done",
      output: ['GATE_EVAL: {"gate":"quality","passed":false,"feedback":"Missing error handling","confidence":0.8}'],
    });
    const manager = makeManager({ getJob: vi.fn(() => evalJob) });
    const job = makeJob({ qualityRubric: "must handle errors" });
    const result = await runQualityGate({ job, manager: manager as any, workerOutputLines: [] });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("Missing error handling");
  });

  it("fails open when spawn throws", async () => {
    const manager = makeManager({ spawn: vi.fn(async () => { throw new Error("quota"); }) });
    const job = makeJob({ qualityRubric: "any rubric" });
    const result = await runQualityGate({ job, manager: manager as any, workerOutputLines: [] });
    expect(result.passed).toBe(true); // fail open
  });

  it("fails open when eval agent produces no GATE_EVAL output", async () => {
    const evalJob = makeJob({ id: "eval-job-id", status: "done", output: ["no json here"] });
    const manager = makeManager({ getJob: vi.fn(() => evalJob) });
    const job = makeJob({ qualityRubric: "some rubric" });
    const result = await runQualityGate({ job, manager: manager as any, workerOutputLines: [] });
    expect(result.passed).toBe(true);
  });
});

// ─── runLoopGates ─────────────────────────────────────────────────────────────

describe("runLoopGates", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns rerun=false when all gates pass", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));
    const job = makeJob();
    const manager = makeManager();
    const outcome = await runLoopGates({ job, manager: manager as any, workDir: "/tmp/work" });
    expect(outcome.rerun).toBe(false);
    expect(outcome.overrideStatus).toBeUndefined();
  });

  it("returns rerun=true with augmented task when completion gate fails and iterations remain", async () => {
    const err = Object.assign(new Error("fail"), { stdout: "", stderr: "3 failing" });
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(err, "", "3 failing"));
    const job = makeJob({ iteration: 1, maxIterations: 3 });
    const manager = makeManager();
    const outcome = await runLoopGates({ job, manager: manager as any, workDir: "/tmp/work" });
    expect(outcome.rerun).toBe(true);
    expect(outcome.newTask).toContain("Gate Feedback");
    expect(outcome.newTask).toContain("npm test");
    expect(outcome.gateFailures[0].gate).toBe("completion");
    expect(outcome.gateFailures[0].iteration).toBe(1);
  });

  it("returns loop_exhausted when max iterations reached", async () => {
    const err = Object.assign(new Error("fail"), { stdout: "", stderr: "fail" });
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(err, "", "fail"));
    const job = makeJob({ iteration: 3, maxIterations: 3 });
    const manager = makeManager();
    const outcome = await runLoopGates({ job, manager: manager as any, workDir: "/tmp/work" });
    expect(outcome.rerun).toBe(false);
    expect(outcome.overrideStatus).toBe("loop_exhausted");
  });

  it("returns loop_stalled when output hash is unchanged from previous iteration", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));
    const job = makeJob({
      iteration: 2,
      output: ["identical output", "line 2"],
      loopOutputHash: computeOutputHash(["identical output", "line 2"]),
    });
    const manager = makeManager();
    const outcome = await runLoopGates({ job, manager: manager as any, workDir: "/tmp/work" });
    expect(outcome.rerun).toBe(false);
    expect(outcome.overrideStatus).toBe("loop_stalled");
  });

  it("does not detect stall on first iteration even if hash matches", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));
    const job = makeJob({
      iteration: 1,
      output: ["some output"],
      loopOutputHash: computeOutputHash(["some output"]),
    });
    const manager = makeManager();
    const outcome = await runLoopGates({ job, manager: manager as any, workDir: "/tmp/work" });
    // iteration=1 is exempt from stall check (no previous iteration to compare)
    expect(outcome.overrideStatus).toBeUndefined();
  });

  it("accumulates gate failures across iterations", async () => {
    const err = Object.assign(new Error("fail"), { stdout: "", stderr: "test fail" });
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(err, "", "test fail"));
    const priorFailure: GateFailure = { gate: "completion", reason: "prior fail", iteration: 1 };
    const job = makeJob({ iteration: 2, maxIterations: 3, gateFailures: [priorFailure] });
    const manager = makeManager();
    const outcome = await runLoopGates({ job, manager: manager as any, workDir: "/tmp/work" });
    expect(outcome.gateFailures).toHaveLength(2);
    expect(outcome.gateFailures[0].iteration).toBe(1);
    expect(outcome.gateFailures[1].iteration).toBe(2);
  });

  it("includes prior gate failures in re-prompt feedback", async () => {
    const err = Object.assign(new Error("fail"), { stdout: "", stderr: "tests broken" });
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(err, "", "tests broken"));
    const priorFailure: GateFailure = { gate: "completion", reason: "prior: compile error", iteration: 1 };
    const job = makeJob({ iteration: 2, maxIterations: 3, gateFailures: [priorFailure] });
    const manager = makeManager();
    const outcome = await runLoopGates({ job, manager: manager as any, workDir: "/tmp/work" });
    expect(outcome.newTask).toContain("prior: compile error");
    expect(outcome.newTask).toContain("tests broken");
  });

  it("hard-caps maxIterations at LOOP_MAX_ITERATIONS", async () => {
    const err = Object.assign(new Error("fail"), { stdout: "", stderr: "fail" });
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(err, "", "fail"));
    // Even if caller passes max_iterations=100, cap at LOOP_MAX_ITERATIONS
    const job = makeJob({ iteration: LOOP_MAX_ITERATIONS, maxIterations: 100 });
    const manager = makeManager();
    const outcome = await runLoopGates({ job, manager: manager as any, workDir: "/tmp/work" });
    expect(outcome.overrideStatus).toBe("loop_exhausted");
  });
});
