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
import { GeminiDriver } from "../gemini.js";
import type { UsageEvent } from "../types.js";

// ─── fake process factory ─────────────────────────────────────────────────────

function makeFakeProc(pid = 54321) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = { write: vi.fn(), destroyed: false };
  const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid, kill: vi.fn() });
  return proc as typeof proc & { stdout: typeof stdout; stderr: typeof stderr; stdin: typeof stdin };
}

function emitNdjson(stdout: EventEmitter, obj: unknown) {
  stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
}

// ─── GeminiDriver ─────────────────────────────────────────────────────────────

describe("GeminiDriver", () => {
  let driver: GeminiDriver;
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    driver = new GeminiDriver();
    vi.clearAllMocks();
  });

  it("has name 'gemini'", () => {
    expect(driver.name).toBe("gemini");
  });

  it("hasSession always returns false", () => {
    expect(driver.hasSession("/any/path")).toBe(false);
  });

  // ─── estimateCost ─────────────────────────────────────────────────────────

  it("estimateCost returns 0 for zero usage", () => {
    expect(driver.estimateCost({ inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("estimateCost returns costUsd when provided", () => {
    const u: UsageEvent = { inputTokens: 100, outputTokens: 100, costUsd: 0.05 };
    expect(driver.estimateCost(u)).toBe(0.05);
  });

  it("estimateCost calculates from token count for gemini-2.5-pro", () => {
    // Pricing for gemini-2.5-pro: $1.25/M input, $10/M output
    const cost = driver.estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      "gemini-2.5-pro"
    );
    // $1.25 + $10 = $11.25
    expect(typeof cost).toBe("number");
    expect(cost).toBeGreaterThan(0);
  });

  // ─── spawn: structured content event ─────────────────────────────────────

  it("emits text for { type: 'content', value: string }", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    emitNdjson(fakeProc.stdout, { type: "content", value: "Hello from Gemini" });
    expect(texts).toContain("Hello from Gemini");
  });

  it("emits text for { type: 'content', text: string } fallback field", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    emitNdjson(fakeProc.stdout, { type: "content", text: "Alt field text" });
    expect(texts).toContain("Alt field text");
  });

  // ─── spawn: tool_call events ───────────────────────────────────────────────

  it("emits tool for { type: 'tool_call', name: string }", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const tools: string[] = [];
    agentProc.on("tool", (n) => tools.push(n));

    emitNdjson(fakeProc.stdout, { type: "tool_call", name: "run_shell" });
    expect(tools).toContain("run_shell");
  });

  it("emits tool for { type: 'tool_use', name: string }", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const tools: string[] = [];
    agentProc.on("tool", (n) => tools.push(n));

    emitNdjson(fakeProc.stdout, { type: "tool_use", name: "read_file" });
    expect(tools).toContain("read_file");
  });

  // ─── spawn: usage event ────────────────────────────────────────────────────

  it("emits usage for { type: 'usage', inputTokens, outputTokens }", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const usageEvents: UsageEvent[] = [];
    agentProc.on("usage", (u) => usageEvents.push(u));

    emitNdjson(fakeProc.stdout, { type: "usage", inputTokens: 200, outputTokens: 80 });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].inputTokens).toBe(200);
    expect(usageEvents[0].outputTokens).toBe(80);
  });

  it("emits usage for usageMetadata shape", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const usageEvents: UsageEvent[] = [];
    agentProc.on("usage", (u) => usageEvents.push(u));

    emitNdjson(fakeProc.stdout, {
      usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 60 },
    });
    expect(usageEvents.some((u) => u.inputTokens === 150 && u.outputTokens === 60)).toBe(true);
  });

  // ─── spawn: error event ────────────────────────────────────────────────────

  it("emits text prefixed with [gemini error] for { type: 'error', message }", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    emitNdjson(fakeProc.stdout, { type: "error", message: "quota exceeded" });
    expect(texts.some((t) => t.includes("[gemini error]") && t.includes("quota exceeded"))).toBe(true);
  });

  // ─── spawn: candidates (raw API) shape ─────────────────────────────────────

  it("emits text from candidates[].content.parts[].text", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    emitNdjson(fakeProc.stdout, {
      candidates: [
        { content: { parts: [{ text: "raw api text" }] } },
      ],
    });
    expect(texts).toContain("raw api text");
  });

  it("emits tool from candidates[].content.parts[].functionCall", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const tools: string[] = [];
    agentProc.on("tool", (n) => tools.push(n));

    emitNdjson(fakeProc.stdout, {
      candidates: [
        { content: { parts: [{ functionCall: { name: "my_tool" } }] } },
      ],
    });
    expect(tools).toContain("my_tool");
  });

  // ─── spawn: non-JSON line fallback ────────────────────────────────────────

  it("emits raw non-JSON lines as text", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    fakeProc.stdout.emit("data", Buffer.from("plain text line\n"));
    expect(texts).toContain("plain text line");
  });

  // ─── spawn: stderr ────────────────────────────────────────────────────────

  it("prefixes stderr with [gemini stderr]", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    fakeProc.stderr.emit("data", Buffer.from("api key invalid"));
    expect(texts.some((t) => t.includes("[gemini stderr]") && t.includes("api key invalid"))).toBe(true);
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

    // Emit a partial JSON line (no newline) — should be flushed on exit
    fakeProc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "content", value: "flush me" })));
    fakeProc.emit("exit", 0);

    expect(texts).toContain("flush me");
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

  // ─── spawn: GEMINI_API_KEY mapping ─────────────────────────────────────────

  it("maps token option to GEMINI_API_KEY env var", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, token: "gemini-key-xyz" });

    const [, , spawnOpts] = mockSpawn.mock.calls[0] as [unknown, unknown, { env: NodeJS.ProcessEnv }];
    expect(spawnOpts.env?.GEMINI_API_KEY).toBe("gemini-key-xyz");
  });
});
