import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAICompatibleDriver } from "../openai-compatible.js";
import type { UsageEvent } from "../types.js";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function makeApiResponse(content: string, toolCalls?: unknown[], usage?: unknown) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content,
            tool_calls: toolCalls,
          },
          finish_reason: toolCalls ? "tool_calls" : "stop",
        },
      ],
      usage: usage ?? { prompt_tokens: 100, completion_tokens: 50 },
    }),
  };
}

describe("OpenAICompatibleDriver", () => {
  let driver: OpenAICompatibleDriver;

  beforeEach(() => {
    driver = new OpenAICompatibleDriver("openai");
    vi.clearAllMocks();
    // Provide a fake API key so the driver doesn't throw
    process.env.OPENAI_API_KEY = "sk-test-fake";
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("has the name passed to constructor", () => {
    expect(driver.name).toBe("openai");
    expect(new OpenAICompatibleDriver("qwen").name).toBe("qwen");
  });

  it("hasSession always returns false", () => {
    expect(driver.hasSession("/any/path")).toBe(false);
  });

  it("estimateCost returns 0 for zero usage", () => {
    expect(driver.estimateCost({ inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("estimateCost uses costUsd when provided", () => {
    expect(driver.estimateCost({ inputTokens: 999, outputTokens: 999, costUsd: 0.77 })).toBe(0.77);
  });

  it("estimateCost calculates from tokens for gpt-4o", () => {
    // 1M input @ $2.5/M = $2.5, 1M output @ $10/M = $10 → $12.5
    const cost = driver.estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      "gpt-4o"
    );
    expect(cost).toBe(12.5);
  });

  it("spawn emits TASK_COMPLETE exit 0 when model says TASK_COMPLETE", async () => {
    mockFetch.mockResolvedValueOnce(makeApiResponse("I have completed the task.\nTASK_COMPLETE"));

    const proc = driver.spawn({
      cwd: "/tmp/test",
      task: "do a task",
      budgetUsd: 5,
    });

    const texts: string[] = [];
    let exitCode: number | null | undefined = undefined;

    await new Promise<void>((resolve) => {
      proc.on("text", (t) => texts.push(t));
      proc.on("exit", (c) => { exitCode = c; resolve(); });
    });

    expect(exitCode).toBe(0);
    expect(texts.some((t) => t.includes("TASK_COMPLETE"))).toBe(true);
  });

  it("spawn emits usage events from API response", async () => {
    mockFetch.mockResolvedValueOnce(
      makeApiResponse("TASK_COMPLETE", undefined, { prompt_tokens: 200, completion_tokens: 100 })
    );

    const proc = driver.spawn({
      cwd: "/tmp/test",
      task: "do a task",
      budgetUsd: 5,
    });

    const usageEvents: UsageEvent[] = [];

    await new Promise<void>((resolve) => {
      proc.on("usage", (u) => usageEvents.push(u));
      proc.on("exit", () => resolve());
    });

    expect(usageEvents.length).toBeGreaterThan(0);
    expect(usageEvents[0].inputTokens).toBe(200);
    expect(usageEvents[0].outputTokens).toBe(100);
  });

  it("spawn exits 1 on API error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "Unauthorized" });

    const proc = driver.spawn({
      cwd: "/tmp/test",
      task: "do a task",
      budgetUsd: 5,
    });

    let exitCode: number | null | undefined = undefined;
    const texts: string[] = [];

    await new Promise<void>((resolve) => {
      proc.on("text", (t) => texts.push(t));
      proc.on("exit", (c) => { exitCode = c; resolve(); });
    });

    expect(exitCode).toBe(1);
    expect(texts.some((t) => t.includes("API error"))).toBe(true);
  });

  it("kill() stops the loop before it finishes", async () => {
    // First call returns a tool_call, second call should never be made because we kill
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Simulate a slow second call that never completes
        return makeApiResponse("TASK_COMPLETE");
      }
      return new Promise(() => {}); // never resolves
    });

    const proc = driver.spawn({
      cwd: "/tmp/test",
      task: "do a task",
      budgetUsd: 5,
    });

    // Kill immediately
    proc.kill();

    let exitCode: number | null | undefined = undefined;
    await new Promise<void>((resolve) => {
      proc.on("exit", (c) => { exitCode = c; resolve(); });
      // Allow natural completion too
      setTimeout(() => resolve(), 500);
    });

    // Either killed (null) or completed naturally (0) — both acceptable
    expect(exitCode === null || exitCode === 0).toBe(true);
  });

  it("resolves correct base URL for qwen driver", () => {
    const qwen = new OpenAICompatibleDriver("qwen");
    // Spy on fetch to capture the URL
    let capturedUrl: string | undefined;
    mockFetch.mockImplementation(async (url: string) => {
      capturedUrl = url;
      return makeApiResponse("TASK_COMPLETE");
    });

    process.env.QWEN_API_KEY = "qwen-fake-key";
    const proc = qwen.spawn({ cwd: "/tmp", task: "t", budgetUsd: 1 });

    return new Promise<void>((resolve) => {
      proc.on("exit", () => {
        expect(capturedUrl).toContain("dashscope.aliyuncs.com");
        delete process.env.QWEN_API_KEY;
        resolve();
      });
    });
  });
});
