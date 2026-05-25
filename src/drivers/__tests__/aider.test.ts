import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { AiderDriver } from "../aider.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockExistsSync, mockSpawn } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: mockExistsSync };
});

vi.mock("child_process", () => ({ spawn: mockSpawn }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeProc(pid = 1234) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = { write: vi.fn(), destroyed: false };
  const proc = Object.assign(new EventEmitter(), { pid, stdout, stderr, stdin, kill: vi.fn() });
  return proc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AiderDriver", () => {
  let driver: AiderDriver;

  beforeEach(() => {
    driver = new AiderDriver();
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false); // default: nothing found
  });

  // --- metadata ---

  it("has name 'aider'", () => {
    expect(driver.name).toBe("aider");
  });

  // --- resolveBinary ---

  it("resolveBinary returns binary found in PATH", () => {
    process.env.PATH = "/usr/local/bin:/usr/bin";
    mockExistsSync.mockImplementation((p: string) => p === "/usr/local/bin/aider");
    expect(driver.resolveBinary()).toBe("/usr/local/bin/aider");
  });

  it("resolveBinary checks fallback paths when PATH has no match", () => {
    process.env.PATH = "/no/such/dir";
    mockExistsSync.mockImplementation((p: string) => p === "/opt/homebrew/bin/aider");
    expect(driver.resolveBinary()).toBe("/opt/homebrew/bin/aider");
  });

  it("resolveBinary returns 'aider' when nothing is found", () => {
    process.env.PATH = "/no/such/dir";
    mockExistsSync.mockReturnValue(false);
    expect(driver.resolveBinary()).toBe("aider");
  });

  // --- hasSession ---

  it("hasSession returns true when .aider.chat.history.md exists", () => {
    mockExistsSync.mockReturnValue(true);
    expect(driver.hasSession("/some/project")).toBe(true);
  });

  it("hasSession returns false when history file is absent", () => {
    mockExistsSync.mockReturnValue(false);
    expect(driver.hasSession("/some/project")).toBe(false);
  });

  // --- spawn: text events ---

  it("spawn emits text lines from stdout", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "do thing", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    proc.stdout.emit("data", Buffer.from("line one\nline two\n"));
    expect(texts).toContain("line one");
    expect(texts).toContain("line two");
  });

  it("spawn buffers partial lines and emits when newline arrives", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    proc.stdout.emit("data", Buffer.from("partial"));
    expect(texts).toHaveLength(0); // no newline yet

    proc.stdout.emit("data", Buffer.from(" line\n"));
    expect(texts).toContain("partial line");
  });

  it("spawn emits stderr lines with [aider stderr] prefix", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    proc.stderr.emit("data", Buffer.from("some error"));
    expect(texts.some((t) => t.includes("[aider stderr]") && t.includes("some error"))).toBe(true);
  });

  // --- spawn: exit event ---

  it("spawn emits exit code on process exit", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    let exitCode: number | null = null;
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("exit", (c) => { exitCode = c; });

    proc.emit("exit", 0);
    expect(exitCode).toBe(0);
  });

  it("spawn emits remaining buffer content on exit", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    // Data without trailing newline
    proc.stdout.emit("data", Buffer.from("leftover"));
    proc.emit("exit", 0);

    expect(texts).toContain("leftover");
  });

  // --- spawn: kill ---

  it("kill() kills the underlying process", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    agentProc.kill();

    expect(proc.kill).toHaveBeenCalled();
  });

  it("kill() suppresses the exit event", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    let exitEmitted = false;
    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    agentProc.on("exit", () => { exitEmitted = true; });
    agentProc.kill();
    proc.emit("exit", 1);

    expect(exitEmitted).toBe(false);
  });

  // --- spawn: env/args ---

  it("sets OPENAI_API_KEY when token starts with sk-", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, token: "sk-mykey" });

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv.OPENAI_API_KEY).toBe("sk-mykey");
  });

  it("does not set OPENAI_API_KEY for non-sk- tokens", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, token: "oauth-token-abc" });

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv.OPENAI_API_KEY).toBeUndefined();
  });

  it("passes custom model in args", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, model: "gpt-4-turbo" });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("gpt-4-turbo");
  });

  it("defaults to gpt-4o when no model is specified", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("gpt-4o");
  });

  it("includes --yes --no-pretty --no-stream flags", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("--yes");
    expect(args).toContain("--no-pretty");
    expect(args).toContain("--no-stream");
  });

  it("sets pid from underlying process", () => {
    const proc = makeFakeProc(9876);
    mockSpawn.mockReturnValue(proc);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    expect(agentProc.pid).toBe(9876);
  });

  // --- spawn: error event ---

  it("emits text and exit(1) on process error", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    let exitCode: number | null = null;
    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    agentProc.on("text", (t) => texts.push(t));
    agentProc.on("exit", (c) => { exitCode = c; });

    proc.emit("error", new Error("ENOENT"));

    expect(texts.some((t) => t.includes("[aider]"))).toBe(true);
    expect(exitCode).toBe(1);
  });

  // --- estimateCost ---

  it("estimateCost returns costUsd directly when provided", () => {
    expect(driver.estimateCost({ inputTokens: 999, outputTokens: 999, costUsd: 0.77 })).toBe(0.77);
  });

  it("estimateCost returns 0 for zero tokens", () => {
    expect(driver.estimateCost({ inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("estimateCost calculates from token counts for gpt-4o", () => {
    // gpt-4o: $2.5/M input, $10/M output → 1M each = $12.5
    expect(driver.estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, "gpt-4o")).toBe(12.5);
  });

  it("estimateCost rounds to 4 decimal places", () => {
    const cost = driver.estimateCost({ inputTokens: 1, outputTokens: 1 }, "gpt-4o");
    expect(cost.toString()).toMatch(/^\d+(\.\d{1,4})?$/);
  });
});
