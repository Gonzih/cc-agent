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
import { CodexDriver } from "../codex.js";
import type { UsageEvent } from "../types.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeFakeProc(pid = 33333) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = { write: vi.fn(), destroyed: false };
  const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid, kill: vi.fn() });
  return proc as typeof proc & { stdout: typeof stdout; stderr: typeof stderr; stdin: typeof stdin };
}

// ─── CodexDriver ──────────────────────────────────────────────────────────────

describe("CodexDriver", () => {
  let driver: CodexDriver;
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    driver = new CodexDriver();
    vi.clearAllMocks();
  });

  it("has name 'codex'", () => {
    expect(driver.name).toBe("codex");
  });

  it("hasSession always returns false", () => {
    expect(driver.hasSession("/any/path")).toBe(false);
  });

  // ─── estimateCost ─────────────────────────────────────────────────────────

  it("estimateCost returns 0 for zero usage", () => {
    expect(driver.estimateCost({ inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("estimateCost returns costUsd directly when provided", () => {
    const u: UsageEvent = { inputTokens: 1000, outputTokens: 500, costUsd: 0.77 };
    expect(driver.estimateCost(u)).toBe(0.77);
  });

  it("estimateCost calculates from tokens for gpt-4.1", () => {
    const cost = driver.estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      "gpt-4.1"
    );
    expect(typeof cost).toBe("number");
    expect(cost).toBeGreaterThan(0);
  });

  // ─── spawn: stdout line buffering ─────────────────────────────────────────

  it("emits text for each complete stdout line", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    fakeProc.stdout.emit("data", Buffer.from("output line 1\noutput line 2\n"));

    expect(texts).toContain("output line 1");
    expect(texts).toContain("output line 2");
  });

  it("buffers partial lines across multiple data events", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    fakeProc.stdout.emit("data", Buffer.from("partial"));
    expect(texts).toHaveLength(0);

    fakeProc.stdout.emit("data", Buffer.from("-completed\n"));
    expect(texts).toContain("partial-completed");
  });

  it("skips empty lines", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    fakeProc.stdout.emit("data", Buffer.from("\n\n  \nreal line\n"));
    // Only "real line" should be emitted — empty/whitespace-only lines are skipped
    expect(texts.filter((t) => t.trim().length > 0)).toEqual(["real line"]);
  });

  it("flushes remaining buffer on exit", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "task", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    fakeProc.stdout.emit("data", Buffer.from("no trailing newline"));
    fakeProc.emit("exit", 0);

    expect(texts).toContain("no trailing newline");
  });

  it("emits exit event with the process exit code", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    let exitCode: number | null | undefined;
    agentProc.on("exit", (c) => { exitCode = c; });

    fakeProc.emit("exit", 0);
    expect(exitCode).toBe(0);
  });

  it("propagates non-zero exit code", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    let exitCode: number | null | undefined;
    agentProc.on("exit", (c) => { exitCode = c; });

    fakeProc.emit("exit", 1);
    expect(exitCode).toBe(1);
  });

  // ─── spawn: stderr ────────────────────────────────────────────────────────

  it("prefixes stderr with [codex stderr]", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const texts: string[] = [];
    agentProc.on("text", (t) => texts.push(t));

    fakeProc.stderr.emit("data", Buffer.from("rate limit hit"));
    expect(texts.some((t) => t.includes("[codex stderr]") && t.includes("rate limit hit"))).toBe(true);
  });

  // ─── spawn: process error ─────────────────────────────────────────────────

  it("emits text and exit(1) on process error event", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    const texts: string[] = [];
    let exitCode: number | null | undefined;
    agentProc.on("text", (t) => texts.push(t));
    agentProc.on("exit", (c) => { exitCode = c; });

    fakeProc.emit("error", new Error("spawn ENOENT"));
    expect(texts.some((t) => t.includes("[codex]"))).toBe(true);
    expect(exitCode).toBe(1);
  });

  // ─── spawn: kill ──────────────────────────────────────────────────────────

  it("kill() calls proc.kill() and suppresses exit event", () => {
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

  // ─── spawn: OPENAI_API_KEY mapping ────────────────────────────────────────

  it("maps token option to OPENAI_API_KEY", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5, token: "sk-codex-key" });

    const [, , spawnOpts] = mockSpawn.mock.calls[0] as [unknown, unknown, { env: NodeJS.ProcessEnv }];
    expect(spawnOpts.env?.OPENAI_API_KEY).toBe("sk-codex-key");
  });

  // ─── spawn: CLI args ──────────────────────────────────────────────────────

  it("passes --model and --full-auto flags", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    driver.spawn({ cwd: "/tmp", task: "do work", budgetUsd: 5, model: "gpt-4o-mini" });

    const [, args] = mockSpawn.mock.calls[0] as [unknown, string[]];
    expect(args).toContain("--full-auto");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-4o-mini");
  });

  it("uses exec subcommand and passes task as positional arg", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    driver.spawn({ cwd: "/tmp", task: "my task text", budgetUsd: 5 });

    const [, args] = mockSpawn.mock.calls[0] as [unknown, string[]];
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("my task text");
  });

  it("uses gpt-4.1 as default model", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });

    const [, args] = mockSpawn.mock.calls[0] as [unknown, string[]];
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-4.1");
  });

  // ─── spawn: pid propagation ───────────────────────────────────────────────

  it("exposes the process pid", () => {
    const fakeProc = makeFakeProc(77777);
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    expect(agentProc.pid).toBe(77777);
  });

  // ─── spawn: writeStdin ────────────────────────────────────────────────────

  it("writeStdin writes to proc.stdin", () => {
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValue(fakeProc as ReturnType<typeof spawn>);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    agentProc.writeStdin?.("input data");

    expect(fakeProc.stdin.write).toHaveBeenCalledWith("input data");
  });
});
