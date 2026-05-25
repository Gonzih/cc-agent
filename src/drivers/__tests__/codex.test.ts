import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { CodexDriver } from "../codex.js";

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
  return Object.assign(new EventEmitter(), { pid, stdout, stderr, stdin, kill: vi.fn() });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodexDriver", () => {
  let driver: CodexDriver;

  beforeEach(() => {
    driver = new CodexDriver();
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    delete process.env.OPENAI_API_KEY;
  });

  // --- metadata ---

  it("has name 'codex'", () => {
    expect(driver.name).toBe("codex");
  });

  it("hasSession always returns false (no persistent sessions)", () => {
    expect(driver.hasSession("/any/cwd")).toBe(false);
  });

  // --- resolveBinary ---

  it("resolveBinary returns binary found in PATH", () => {
    process.env.PATH = "/usr/local/bin:/usr/bin";
    mockExistsSync.mockImplementation((p: string) => p === "/usr/local/bin/codex");
    expect(driver.resolveBinary()).toBe("/usr/local/bin/codex");
  });

  it("resolveBinary checks cargo bin fallback", () => {
    process.env.PATH = "/no/such/dir";
    const home = process.env.HOME ?? "/home/test";
    mockExistsSync.mockImplementation((p: string) => p === `${home}/.cargo/bin/codex`);
    expect(driver.resolveBinary()).toBe(`${home}/.cargo/bin/codex`);
  });

  it("resolveBinary returns 'codex' when nothing found", () => {
    process.env.PATH = "";
    mockExistsSync.mockReturnValue(false);
    expect(driver.resolveBinary()).toBe("codex");
  });

  // --- spawn: args ---

  it("passes 'exec' as first arg followed by the task", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "do the work", budgetUsd: 5 });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("do the work");
  });

  it("includes --model flag with provided model", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, model: "gpt-4.1-mini" });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("--model");
    expect(args).toContain("gpt-4.1-mini");
  });

  it("defaults to gpt-4.1 when no model specified", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("gpt-4.1");
  });

  it("includes --full-auto flag", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("--full-auto");
  });

  it("sets OPENAI_API_KEY from options.token", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, token: "sk-token" });

    expect(mockSpawn.mock.calls[0][2].env.OPENAI_API_KEY).toBe("sk-token");
  });

  it("picks up OPENAI_API_KEY from process.env when no token provided", () => {
    process.env.OPENAI_API_KEY = "sk-env-key";
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });

    expect(mockSpawn.mock.calls[0][2].env.OPENAI_API_KEY).toBe("sk-env-key");
  });

  // --- spawn: text events (plain text output, no JSON) ---

  it("emits text lines from stdout", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    proc.stdout.emit("data", Buffer.from("codex output line 1\ncodex output line 2\n"));

    expect(texts).toContain("codex output line 1");
    expect(texts).toContain("codex output line 2");
  });

  it("buffers partial stdout lines until newline", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    proc.stdout.emit("data", Buffer.from("partial"));
    expect(texts).toHaveLength(0);

    proc.stdout.emit("data", Buffer.from(" complete\n"));
    expect(texts).toContain("partial complete");
  });

  it("emits remaining buffer content on exit", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    proc.stdout.emit("data", Buffer.from("no newline at end"));
    proc.emit("exit", 0);

    expect(texts).toContain("no newline at end");
  });

  // --- spawn: stderr ---

  it("emits stderr text with [codex stderr] prefix", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    proc.stderr.emit("data", Buffer.from("codex error"));
    expect(texts.some((t) => t.includes("[codex stderr]") && t.includes("codex error"))).toBe(true);
  });

  // --- spawn: exit ---

  it("emits exit code on process exit", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    let code: number | null = null;
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("exit", (c) => { code = c; });

    proc.emit("exit", 0);
    expect(code).toBe(0);
  });

  it("emits non-zero exit code on failure", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    let code: number | null = null;
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("exit", (c) => { code = c; });

    proc.emit("exit", 2);
    expect(code).toBe(2);
  });

  // --- spawn: error event ---

  it("emits [codex] error text and exit(1) on process error", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    let code: number | null = null;
    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    agentProc.on("text", (t) => texts.push(t));
    agentProc.on("exit", (c) => { code = c; });

    proc.emit("error", new Error("binary not found"));

    expect(texts.some((t) => t.includes("[codex]"))).toBe(true);
    expect(code).toBe(1);
  });

  // --- spawn: kill ---

  it("kill() stops the process and suppresses the exit event", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    let exitEmitted = false;
    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    agentProc.on("exit", () => { exitEmitted = true; });
    agentProc.kill();
    proc.emit("exit", 1);

    expect(proc.kill).toHaveBeenCalled();
    expect(exitEmitted).toBe(false);
  });

  it("sets pid from underlying process", () => {
    const proc = makeFakeProc(5555);
    mockSpawn.mockReturnValue(proc);

    expect(driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).pid).toBe(5555);
  });

  // --- estimateCost ---

  it("estimateCost returns costUsd when provided", () => {
    expect(driver.estimateCost({ inputTokens: 1, outputTokens: 1, costUsd: 0.99 })).toBe(0.99);
  });

  it("estimateCost returns 0 for zero tokens", () => {
    expect(driver.estimateCost({ inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("estimateCost calculates from token counts for gpt-4.1", () => {
    // gpt-4.1: $2/M input, $8/M output → 1M each = $10
    expect(driver.estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, "gpt-4.1")).toBe(10);
  });

  it("estimateCost rounds to 4 decimal places", () => {
    const cost = driver.estimateCost({ inputTokens: 100, outputTokens: 50 }, "gpt-4.1");
    const rounded = Math.round(cost * 10000) / 10000;
    expect(cost).toBe(rounded);
  });
});
