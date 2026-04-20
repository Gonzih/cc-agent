import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeCodeDriver } from "../claude-code.js";
import type { UsageEvent } from "../types.js";

// Mock the claude module so we don't need the actual binary
vi.mock("../../claude.js", () => ({
  runClaude: vi.fn(),
  resolveClaude: vi.fn(() => "/mock/bin/claude"),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      // Simulate /mock/bin/claude existing
      if (path === "/mock/bin/claude") return true;
      // Simulate a session directory
      if (path.includes("test-project")) return true;
      return actual.existsSync(path);
    }),
  };
});

describe("ClaudeCodeDriver", () => {
  let driver: ClaudeCodeDriver;

  beforeEach(() => {
    driver = new ClaudeCodeDriver();
    vi.clearAllMocks();
  });

  it("has name 'claude'", () => {
    expect(driver.name).toBe("claude");
  });

  it("resolveBinary returns a string", () => {
    const bin = driver.resolveBinary?.();
    expect(typeof bin).toBe("string");
    expect(bin!.length).toBeGreaterThan(0);
  });

  it("estimateCost returns 0 for zero usage", () => {
    const cost = driver.estimateCost({ inputTokens: 0, outputTokens: 0 });
    expect(cost).toBe(0);
  });

  it("estimateCost uses costUsd when provided", () => {
    const cost = driver.estimateCost({ inputTokens: 1000000, outputTokens: 1000000, costUsd: 0.42 });
    expect(cost).toBe(0.42);
  });

  it("estimateCost calculates from tokens for claude-sonnet-4-6", () => {
    // 1M input @ $3/M = $3, 1M output @ $15/M = $15 → $18
    const cost = driver.estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      "claude-sonnet-4-6"
    );
    expect(cost).toBe(18.0);
  });

  it("estimateCost includes cache tokens", () => {
    // 1M cache-read @ $0.30/M = $0.30
    const cost = driver.estimateCost(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
      "claude-sonnet-4-6"
    );
    expect(cost).toBe(0.30);
  });

  it("spawn emits events from runClaude", async () => {
    const { EventEmitter } = await import("events");
    const { runClaude } = await import("../../claude.js");

    const mockProc = new EventEmitter() as ReturnType<typeof runClaude> & { kill: () => void; stdin: null; pid: number };
    mockProc.kill = vi.fn();
    mockProc.stdin = null;
    mockProc.pid = 12345;

    (runClaude as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);

    const agentProc = driver.spawn({
      cwd: "/tmp/test",
      task: "do something",
      budgetUsd: 10,
    });

    const texts: string[] = [];
    const tools: string[] = [];
    let exitCode: number | null = null;
    let sessionId: string | undefined;

    agentProc.on("text", (t) => texts.push(t));
    agentProc.on("tool", (n) => tools.push(n));
    agentProc.on("exit", (c) => { exitCode = c; });
    agentProc.on("sessionId", (s) => { sessionId = s; });

    // Simulate events from the mock Claude process
    mockProc.emit("text", "hello world");
    mockProc.emit("tool", "bash /tmp/test");
    mockProc.emit("session", "sess-abc123");
    mockProc.emit("exit", 0);

    expect(texts).toContain("hello world");
    expect(tools).toContain("bash /tmp/test");
    expect(sessionId).toBe("sess-abc123");
    expect(exitCode).toBe(0);
    expect(agentProc.pid).toBe(12345);
  });

  it("spawn.kill() calls proc.kill()", async () => {
    const { EventEmitter } = await import("events");
    const { runClaude } = await import("../../claude.js");

    const mockProc = new EventEmitter() as ReturnType<typeof runClaude> & { kill: ReturnType<typeof vi.fn>; stdin: null; pid: number };
    mockProc.kill = vi.fn();
    mockProc.stdin = null;
    mockProc.pid = 99999;
    (runClaude as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);

    const agentProc = driver.spawn({ cwd: "/tmp", task: "t", budgetUsd: 5 });
    agentProc.kill();
    expect(mockProc.kill).toHaveBeenCalled();
  });
});
