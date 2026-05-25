import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { AmpDriver } from "../amp.js";
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

describe("AmpDriver", () => {
  let driver: AmpDriver;

  beforeEach(() => {
    driver = new AmpDriver();
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    delete process.env.AMP_API_KEY;
  });

  // --- metadata ---

  it("has name 'amp'", () => {
    expect(driver.name).toBe("amp");
  });

  it("hasSession always returns false (no persistent sessions)", () => {
    expect(driver.hasSession("/any/path")).toBe(false);
  });

  // --- resolveBinary ---

  it("resolveBinary returns binary found in PATH", () => {
    process.env.PATH = "/usr/local/bin:/usr/bin";
    mockExistsSync.mockImplementation((p: string) => p === "/usr/local/bin/amp");
    expect(driver.resolveBinary()).toBe("/usr/local/bin/amp");
  });

  it("resolveBinary checks HOME-based fallback paths", () => {
    process.env.PATH = "/no/such/dir";
    const home = process.env.HOME ?? "/home/test";
    mockExistsSync.mockImplementation((p: string) => p === `${home}/.npm-global/bin/amp`);
    expect(driver.resolveBinary()).toBe(`${home}/.npm-global/bin/amp`);
  });

  it("resolveBinary returns 'amp' when nothing found", () => {
    process.env.PATH = "";
    mockExistsSync.mockReturnValue(false);
    expect(driver.resolveBinary()).toBe("amp");
  });

  // --- spawn: args ---

  it("passes task via --execute flag", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "do a task", budgetUsd: 5 });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("--execute");
    expect(args).toContain("do a task");
  });

  it("includes --stream-json and --dangerously-allow-all flags", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("--stream-json");
    expect(args).toContain("--dangerously-allow-all");
  });

  it("includes --model flag when model is specified", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, model: "claude-3-opus" });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toContain("--model");
    expect(args).toContain("claude-3-opus");
  });

  it("omits --model flag when no model specified", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain("--model");
  });

  it("sets AMP_API_KEY from options.token", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, token: "my-amp-key" });

    expect(mockSpawn.mock.calls[0][2].env.AMP_API_KEY).toBe("my-amp-key");
  });

  it("picks up AMP_API_KEY from process.env when no token provided", () => {
    process.env.AMP_API_KEY = "env-amp-key";
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });

    expect(mockSpawn.mock.calls[0][2].env.AMP_API_KEY).toBe("env-amp-key");
  });

  // --- spawn: NDJSON parsing — session ID ---

  it("emits sessionId from session_id field on any event", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    let sessionId: string | undefined;
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("sessionId", (s) => { sessionId = s; });

    emitNdjson(proc.stdout, { type: "message_start", session_id: "sess-abc", message: {} });
    expect(sessionId).toBe("sess-abc");
  });

  // --- spawn: NDJSON parsing — usage events ---

  it("emits usage from message_start event", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const usages: UsageEvent[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("usage", (u) => usages.push(u));

    emitNdjson(proc.stdout, {
      type: "message_start",
      message: {
        usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 },
      },
    });

    expect(usages[0]).toMatchObject({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 20, cacheWriteTokens: 5 });
  });

  it("emits usage from message_delta event", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const usages: UsageEvent[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("usage", (u) => usages.push(u));

    emitNdjson(proc.stdout, { type: "message_delta", usage: { output_tokens: 75 } });
    expect(usages[0]).toMatchObject({ inputTokens: 0, outputTokens: 75 });
  });

  it("emits usage with costUsd from result event", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const usages: UsageEvent[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("usage", (u) => usages.push(u));

    emitNdjson(proc.stdout, { type: "result", result: "done", cost_usd: 0.042 });
    expect(usages.some((u) => u.costUsd === 0.042)).toBe(true);
  });

  // --- spawn: NDJSON parsing — text events ---

  it("emits text from content_block_delta text_delta", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    emitNdjson(proc.stdout, {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hello from amp" },
    });
    expect(texts).toContain("hello from amp");
  });

  it("emits text from result event result field", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    emitNdjson(proc.stdout, { type: "result", result: "final answer" });
    expect(texts).toContain("final answer");
  });

  it("emits text from assistant message string content", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    emitNdjson(proc.stdout, { type: "assistant", message: { content: "assistant text" } });
    expect(texts).toContain("assistant text");
  });

  it("emits text from assistant message content array", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    emitNdjson(proc.stdout, {
      type: "assistant",
      message: { content: [{ type: "text", text: "array text block" }] },
    });
    expect(texts).toContain("array text block");
  });

  // --- spawn: NDJSON parsing — tool events ---

  it("emits tool name from content_block_start tool_use", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const tools: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("tool", (n) => tools.push(n));

    emitNdjson(proc.stdout, {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "bash" },
    });
    expect(tools).toContain("bash");
  });

  it("emits tool name from assistant message content array tool_use block", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const tools: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("tool", (n) => tools.push(n));

    emitNdjson(proc.stdout, {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "read_file" }] },
    });
    expect(tools).toContain("read_file");
  });

  // --- spawn: stderr ---

  it("emits stderr with [amp stderr] prefix", () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const texts: string[] = [];
    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).on("text", (t) => texts.push(t));

    proc.stderr.emit("data", Buffer.from("warning from amp"));
    expect(texts.some((t) => t.includes("[amp stderr]") && t.includes("warning from amp"))).toBe(true);
  });

  // --- spawn: exit / kill ---

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

    proc.stdout.emit("data", Buffer.from('{"type":"result","result":"buffered result"}'));
    proc.emit("exit", 0);

    expect(texts).toContain("buffered result");
  });

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
    const proc = makeFakeProc(7777);
    mockSpawn.mockReturnValue(proc);

    expect(driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 }).pid).toBe(7777);
  });

  // --- estimateCost ---

  it("estimateCost returns costUsd directly when provided", () => {
    expect(driver.estimateCost({ inputTokens: 0, outputTokens: 0, costUsd: 1.5 })).toBe(1.5);
  });

  it("estimateCost returns 0 for zero tokens", () => {
    expect(driver.estimateCost({ inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("estimateCost calculates from token counts", () => {
    // Uses 'amp' pricing key — should return a non-negative number
    const cost = driver.estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(typeof cost).toBe("number");
    expect(cost).toBeGreaterThanOrEqual(0);
  });
});
