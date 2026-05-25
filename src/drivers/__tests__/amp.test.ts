import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "child_process";
import { AmpDriver } from "../amp.js";
import type { UsageEvent } from "../types.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeFakeProc(pid = 22222) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = { write: vi.fn(), destroyed: false };
  const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid, kill: vi.fn() });
  return proc as typeof proc & { stdout: typeof stdout; stderr: typeof stderr; stdin: typeof stdin };
}

function emitNdjson(stdout: EventEmitter, obj: unknown) {
  stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
}

// ─── AmpDriver ────────────────────────────────────────────────────────────────

describe("AmpDriver", () => {
  let driver: AmpDriver;
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    driver = new AmpDriver();
    vi.clearAllMocks();
  });

  it("has name 'amp'", () => {
    expect(driver.name).toBe("amp");
  });

  it("hasSession always returns false", () => {
    expect(driver.hasSession("/any/path")).toBe(false);
  });

  // ─── estimateCost ─────────────────────────────────────────────────────────

  it("estimateCost returns 0 for zero usage", () => {
    expect(driver.estimateCost({ inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("estimateCost returns costUsd directly when provided", () => {
    const u: UsageEvent = { inputTokens: 1000, outputTokens: 500, costUsd: 0.99 };
    expect(driver.estimateCost(u)).toBe(0.99);
  });

  // ─── spawn: message_start ─────────────────────────────────────────────────

  it("emits usage from message_start event", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const usageEvents: UsageEvent[] = [];
    agentProc.on("usage", (u) => usageEvents.push(u));

    emitNdjson(fakeProc.stdout, {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 300,
          output_tokens: 0,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 10,
        },
      },
    });

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].inputTokens).toBe(300);
    expect(usageEvents[0].cacheReadTokens).toBe(50);
    expect(usageEvents[0].cacheWriteTokens).toBe(10);
  });

  // ─── spawn: message_delta ─────────────────────────────────────────────────

  it("emits usage from message_delta event", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const usageEvents: UsageEvent[] = [];
    agentProc.on("usage", (u) => usageEvents.push(u));

    emitNdjson(fakeProc.stdout, {
      type: "message_delta",
      usage: { output_tokens: 120 },
    });

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].outputTokens).toBe(120);
    expect(usageEvents[0].inputTokens).toBe(0);
  });

  // ─── spawn: content_block_delta ───────────────────────────────────────────

  it("emits text from content_block_delta text_delta", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    emitNdjson(fakeProc.stdout, {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "streaming chunk" },
    });

    expect(texts).toContain("streaming chunk");
  });

  it("ignores content_block_delta with non-text delta type", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    emitNdjson(fakeProc.stdout, {
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: "{}" },
    });

    expect(texts).toHaveLength(0);
  });

  // ─── spawn: content_block_start ───────────────────────────────────────────

  it("emits tool from content_block_start with tool_use block", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const tools: string[] = [];
    agentProc.on("tool", (n) => tools.push(n));

    emitNdjson(fakeProc.stdout, {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "bash" },
    });

    expect(tools).toContain("bash");
  });

  // ─── spawn: result event ──────────────────────────────────────────────────

  it("emits text and costUsd usage from result event", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const texts: string[] = [];
    const usageEvents: UsageEvent[] = [];
    agentProc.on("text", (t) => texts.push(t));
    agentProc.on("usage", (u) => usageEvents.push(u));

    emitNdjson(fakeProc.stdout, {
      type: "result",
      result: "Task complete!",
      cost_usd: 0.42,
    });

    expect(texts).toContain("Task complete!");
    expect(usageEvents.some((u) => u.costUsd === 0.42)).toBe(true);
  });

  // ─── spawn: assistant event ───────────────────────────────────────────────

  it("emits text from assistant event with string content", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    emitNdjson(fakeProc.stdout, {
      type: "assistant",
      message: { content: "assistant reply" },
    });

    expect(texts).toContain("assistant reply");
  });

  it("emits text from assistant event with content array", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const texts: string[] = [];
    const tools: string[] = [];
    agentProc.on("text", (t) => texts.push(t));
    agentProc.on("tool", (n) => tools.push(n));

    emitNdjson(fakeProc.stdout, {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "block text" },
          { type: "tool_use", name: "write_file" },
        ],
      },
    });

    expect(texts).toContain("block text");
    expect(tools).toContain("write_file");
  });

  // ─── spawn: session_id ────────────────────────────────────────────────────

  it("emits sessionId when session_id field is present", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    let sessionId: string | undefined;
    agentProc.on("sessionId", (id) => { sessionId = id; });

    emitNdjson(fakeProc.stdout, { session_id: "sess-abc", type: "message_start", message: {} });

    expect(sessionId).toBe("sess-abc");
  });

  // ─── spawn: non-JSON fallback ─────────────────────────────────────────────

  it("emits raw non-JSON lines as text", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    fakeProc.stdout.emit("data", Buffer.from("plain line\n"));
    expect(texts).toContain("plain line");
  });

  // ─── spawn: stderr ────────────────────────────────────────────────────────

  it("prefixes stderr with [amp stderr]", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    fakeProc.stderr.emit("data", Buffer.from("amp error output"));
    expect(texts.some((t) => t.includes("[amp stderr]") && t.includes("amp error output"))).toBe(true);
  });

  // ─── spawn: exit ──────────────────────────────────────────────────────────

  it("emits exit event with the exit code", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    let exitCode: number | null | undefined;
    agentProc.on("exit", (c) => { exitCode = c; });

    fakeProc.emit("exit", 0);
    expect(exitCode).toBe(0);
  });

  it("flushes JSON buffer on exit", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    // No trailing newline — will be flushed at exit
    fakeProc.stdout.emit("data", Buffer.from(
      JSON.stringify({ type: "result", result: "final answer" })
    ));
    fakeProc.emit("exit", 0);

    expect(texts).toContain("final answer");
  });

  // ─── spawn: kill ──────────────────────────────────────────────────────────

  it("kill() suppresses exit event", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    let exitFired = false;
    agentProc.on("exit", () => { exitFired = true; });

    agentProc.kill();
    fakeProc.emit("exit", null);

    expect(fakeProc.kill).toHaveBeenCalled();
    expect(exitFired).toBe(false);
  });

  // ─── spawn: AMP_API_KEY mapping ───────────────────────────────────────────

  it("maps token option to AMP_API_KEY", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, token: "amp-key-123" });

    const [, , spawnOpts] = mockSpawn.mock.calls[0] as [unknown, unknown, { env: NodeJS.ProcessEnv }];
    expect(spawnOpts.env?.AMP_API_KEY).toBe("amp-key-123");
  });

  it("passes --model flag when model option is provided", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, model: "claude-sonnet-4-6" });

    const [, args] = mockSpawn.mock.calls[0] as [unknown, string[]];
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("claude-sonnet-4-6");
  });

  it("omits --model flag when no model option", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });

    const [, args] = mockSpawn.mock.calls[0] as [unknown, string[]];
    expect(args).not.toContain("--model");
  });
});
