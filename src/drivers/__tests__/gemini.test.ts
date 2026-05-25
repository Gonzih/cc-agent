import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { GeminiDriver } from "../gemini.js";
import type { UsageEvent } from "../types.js";

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

function emitNdjson(stdout: EventEmitter, obj: Record<string, unknown>) {
  stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GeminiDriver", () => {
  let driver: GeminiDriver;

  beforeEach(() => {
    driver = new GeminiDriver();
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    delete process.env.GEMINI_API_KEY;
  });

  // --- metadata ---

  it("has name 'gemini'", () => {
    expect(driver.name).toBe("gemini");
  });

  it("hasSession always returns false (no persistent sessions)", () => {
    expect(driver.hasSession("/any/path")).toBe(false);
  });

  // --- resolveBinary ---

  it("resolveBinary returns binary found in PATH", () => {
    process.env.PATH = "/usr/local/bin:/usr/bin";
    mockExistsSync.mockImplementation((p: string) => p === "/usr/local/bin/gemini");
    expect(driver.resolveBinary()).toBe("/usr/local/bin/gemini");
  });

  it("resolveBinary checks HOME-based fallback paths", () => {
    process.env.PATH = "/no/such/dir";
    const home = process.env.HOME ?? "/home/test";
    mockExistsSync.mockImplementation((p: string) => p === `${home}/.npm-global/bin/gemini`);
    expect(driver.resolveBinary()).toBe(`${home}/.npm-global/bin/gemini`);
  });

  it("resolveBinary returns 'gemini' when nothing found", () => {
    process.env.PATH = "";
    mockExistsSync.mockReturnValue(false);
    expect(driver.resolveBinary()).toBe("gemini");
  });

  // --- spawn: args ---

  it("passes task via -p flag", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "do a task", budgetUsd: 5 });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("-p");
    expect(args).toContain("do a task");
  });

  it("includes --output-format stream-json and --yolo flags", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--yolo");
  });

  it("uses provided model", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, model: "gemini-1.5-flash" });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("gemini-1.5-flash");
  });

  it("defaults to gemini-2.5-pro when no model specified", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("gemini-2.5-pro");
  });

  it("sets GEMINI_API_KEY from options.token", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, token: "my-gemini-key" });

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv.GEMINI_API_KEY).toBe("my-gemini-key");
  });

  it("picks up GEMINI_API_KEY from process.env when no token provided", () => {
    process.env.GEMINI_API_KEY = "env-key";
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv.GEMINI_API_KEY).toBe("env-key");
  });

  // --- spawn: NDJSON parsing — text events ---

  it("emits text from {type: 'content', value: string}", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    emitNdjson(proc.stdout, { type: "content", value: "hello gemini" });
    expect(texts).toContain("hello gemini");
  });

  it("emits text from {type: 'content', text: string} alternate field", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    emitNdjson(proc.stdout, { type: "content", text: "alt text field" });
    expect(texts).toContain("alt text field");
  });

  it("emits text from raw Gemini API candidates shape", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    emitNdjson(proc.stdout, {
      candidates: [{ content: { parts: [{ text: "from candidates" }] } }],
    });
    expect(texts).toContain("from candidates");
  });

  it("emits text from plain fallback {text: string} shape", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    emitNdjson(proc.stdout, { text: "plain text shape" });
    expect(texts).toContain("plain text shape");
  });

  it("emits text for {type: 'error'} events with message", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    emitNdjson(proc.stdout, { type: "error", message: "quota exceeded" });
    expect(texts.some((t) => t.includes("[gemini error]") && t.includes("quota exceeded"))).toBe(true);
  });

  it("emits raw non-JSON lines as text", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    proc.stdout.emit("data", Buffer.from("not json at all\n"));
    expect(texts).toContain("not json at all");
  });

  // --- spawn: NDJSON parsing — tool events ---

  it("emits tool name from {type: 'tool_call', name: string}", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const tools: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("tool", (n) => tools.push(n));

    emitNdjson(proc.stdout, { type: "tool_call", name: "bash" });
    expect(tools).toContain("bash");
  });

  it("emits tool name from candidates functionCall", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const tools: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("tool", (n) => tools.push(n));

    emitNdjson(proc.stdout, {
      candidates: [
        { content: { parts: [{ functionCall: { name: "read_file" } }] } },
      ],
    });
    expect(tools).toContain("read_file");
  });

  // --- spawn: NDJSON parsing — usage events ---

  it("emits usage from {type: 'usage'} event", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const usages: UsageEvent[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("usage", (u) => usages.push(u));

    emitNdjson(proc.stdout, { type: "usage", inputTokens: 100, outputTokens: 50 });
    expect(usages[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });

  it("emits usage from usageMetadata shape", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const usages: UsageEvent[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("usage", (u) => usages.push(u));

    emitNdjson(proc.stdout, {
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 80 },
    });
    expect(usages[0]).toMatchObject({ inputTokens: 200, outputTokens: 80 });
  });

  // --- spawn: stderr ---

  it("emits stderr text with [gemini stderr] prefix", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    proc.stderr.emit("data", Buffer.from("stderr warning"));
    expect(texts.some((t) => t.includes("[gemini stderr]") && t.includes("stderr warning"))).toBe(true);
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

  it("processes buffered partial JSON on exit", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    // Send partial (no trailing newline)
    proc.stdout.emit("data", Buffer.from('{"type":"content","value":"final chunk"}'));
    proc.emit("exit", 0);

    expect(texts).toContain("final chunk");
  });

  // --- spawn: kill ---

  it("kill() stops the process and suppresses exit event", () => {
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

  // --- estimateCost ---

  it("estimateCost returns costUsd when provided", () => {
    expect(driver.estimateCost({ inputTokens: 1, outputTokens: 1, costUsd: 0.5 })).toBe(0.5);
  });

  it("estimateCost calculates from tokens for gemini-2.5-pro", () => {
    const cost = driver.estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, "gemini-2.5-pro");
    expect(cost).toBeGreaterThan(0);
    expect(typeof cost).toBe("number");
  });

  it("estimateCost returns 0 for zero tokens with no cost", () => {
    expect(driver.estimateCost({ inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});
