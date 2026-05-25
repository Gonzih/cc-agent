import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// Mock fs so resolveBinary PATH scan always misses — falls back to "aider"
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

// Mock child_process.spawn so no real process is launched
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "child_process";
import { AiderDriver } from "../aider.js";
import type { UsageEvent } from "../types.js";

// ─── fake process factory ─────────────────────────────────────────────────────

function makeFakeProc(pid = 12345) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = { write: vi.fn(), destroyed: false };
  const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid, kill: vi.fn() });
  return proc as typeof proc & { stdout: typeof stdout; stderr: typeof stderr; stdin: typeof stdin };
}

// ─── AiderDriver ─────────────────────────────────────────────────────────────

describe("AiderDriver", () => {
  let driver: AiderDriver;
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    driver = new AiderDriver();
    vi.clearAllMocks();
  });

  it("has name 'aider'", () => {
    expect(driver.name).toBe("aider");
  });

  it("resolveBinary returns a non-empty string", () => {
    const bin = driver.resolveBinary();
    expect(typeof bin).toBe("string");
    expect(bin.length).toBeGreaterThan(0);
  });

  it("hasSession returns true when .aider.chat.history.md exists", async () => {
    const { existsSync } = await import("fs");
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith(".aider.chat.history.md")
    );
    expect(driver.hasSession("/my/project")).toBe(true);
  });

  it("hasSession returns false when .aider.chat.history.md is absent", async () => {
    const { existsSync } = await import("fs");
    vi.mocked(existsSync).mockReturnValue(false);
    expect(driver.hasSession("/my/project")).toBe(false);
  });

  // ─── estimateCost ─────────────────────────────────────────────────────────

  it("estimateCost returns 0 for zero tokens", () => {
    expect(driver.estimateCost({ inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("estimateCost returns costUsd directly when provided", () => {
    const u: UsageEvent = { inputTokens: 500_000, outputTokens: 500_000, costUsd: 1.23 };
    expect(driver.estimateCost(u)).toBe(1.23);
  });

  it("estimateCost calculates from tokens for gpt-4o", () => {
    // 1M input @ $2.5/M + 1M output @ $10/M = $12.5
    const cost = driver.estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, "gpt-4o");
    expect(cost).toBe(12.5);
  });

  // ─── spawn: stdout line buffering ─────────────────────────────────────────

  it("emits text events for each complete stdout line", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "do it", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    fakeProc.stdout.emit("data", Buffer.from("line one\nline two\n"));

    expect(texts).toContain("line one");
    expect(texts).toContain("line two");
  });

  it("buffers partial lines across data events", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    fakeProc.stdout.emit("data", Buffer.from("partial"));
    expect(texts).toHaveLength(0); // no newline yet

    fakeProc.stdout.emit("data", Buffer.from(" line\n"));
    expect(texts).toContain("partial line");
  });

  it("flushes remaining buffer on exit", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    fakeProc.stdout.emit("data", Buffer.from("no newline at end"));
    fakeProc.emit("exit", 0);

    expect(texts).toContain("no newline at end");
  });

  it("emits exit event with the process exit code", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    let exitCode: number | null | undefined;
    agentProc.on("exit", (c) => { exitCode = c; });

    fakeProc.emit("exit", 42);
    expect(exitCode).toBe(42);
  });

  // ─── spawn: stderr ────────────────────────────────────────────────────────

  it("prefixes stderr output with [aider stderr]", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    fakeProc.stderr.emit("data", Buffer.from("some warning"));
    expect(texts.some((t) => t.includes("[aider stderr]") && t.includes("some warning"))).toBe(true);
  });

  // ─── spawn: process error event ───────────────────────────────────────────

  it("emits text and exit(1) on process error", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const texts: string[] = [];
    let exitCode: number | null | undefined;
    agentProc.on("text", (t) => texts.push(t));
    agentProc.on("exit", (c) => { exitCode = c; });

    fakeProc.emit("error", new Error("ENOENT"));
    expect(texts.some((t) => t.includes("[aider]"))).toBe(true);
    expect(exitCode).toBe(1);
  });

  // ─── spawn: kill ──────────────────────────────────────────────────────────

  it("kill() calls proc.kill() and suppresses the exit event", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    let exitFired = false;
    agentProc.on("exit", () => { exitFired = true; });

    agentProc.kill();
    fakeProc.emit("exit", null);

    expect(fakeProc.kill).toHaveBeenCalled();
    expect(exitFired).toBe(false); // killed=true suppresses the event
  });

  // ─── spawn: token mapping ─────────────────────────────────────────────────

  it("maps sk- prefixed token to OPENAI_API_KEY env var", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, token: "sk-abc123" });

    const [, , spawnOpts] = mockSpawn.mock.calls[0] as [unknown, unknown, { env: NodeJS.ProcessEnv }];
    expect(spawnOpts.env?.OPENAI_API_KEY).toBe("sk-abc123");
  });

  it("does not set OPENAI_API_KEY for non-sk tokens", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, token: "some-other-token" });

    const [, , spawnOpts] = mockSpawn.mock.calls[0] as [unknown, unknown, { env: NodeJS.ProcessEnv }];
    expect(spawnOpts.env?.OPENAI_API_KEY).toBeUndefined();

    if (originalKey) process.env.OPENAI_API_KEY = originalKey;
  });

  // ─── spawn: writeStdin ────────────────────────────────────────────────────

  it("writeStdin writes data to proc.stdin", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    agentProc.writeStdin?.("hello stdin");

    expect(fakeProc.stdin.write).toHaveBeenCalledWith("hello stdin");
  });

  // ─── spawn: pid propagation ───────────────────────────────────────────────

  it("exposes the process pid", () => {
    const fakeProc = makeFakeProc(99001);
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    expect(agentProc.pid).toBe(99001);
  });
});
