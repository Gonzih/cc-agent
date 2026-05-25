import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs.existsSync so we can control binary availability
const { mockExistsSync } = vi.hoisted(() => ({ mockExistsSync: vi.fn() }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: mockExistsSync };
});

// Mock child_process (spawn + execFile used by various drivers)
vi.mock("child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));

// Mock the claude module (ClaudeCodeDriver depends on it)
vi.mock("../../claude.js", () => ({
  runClaude: vi.fn(),
  resolveClaude: vi.fn(() => "/mock/bin/claude"),
}));

import { getDriver, listDrivers, getDriverStatus } from "../index.js";
import { ClaudeCodeDriver } from "../claude-code.js";
import { AiderDriver } from "../aider.js";
import { OpenAICompatibleDriver } from "../openai-compatible.js";
import { GeminiDriver } from "../gemini.js";
import { AmpDriver } from "../amp.js";
import { CodexDriver } from "../codex.js";

describe("listDrivers", () => {
  it("returns an array of strings", () => {
    const list = listDrivers();
    expect(Array.isArray(list)).toBe(true);
    expect(list.every((x) => typeof x === "string")).toBe(true);
  });

  it("includes all expected driver names", () => {
    const list = listDrivers();
    for (const name of ["claude", "claude-code", "aider", "openai", "gemini", "amp", "codex"]) {
      expect(list).toContain(name);
    }
  });

  it("includes openai-compatible aliases", () => {
    const list = listDrivers();
    expect(list).toContain("openai-compatible");
    expect(list).toContain("qwen");
    expect(list).toContain("kimi");
    expect(list).toContain("deepseek");
    expect(list).toContain("pi");
  });
});

describe("getDriver", () => {
  it("returns ClaudeCodeDriver for 'claude'", () => {
    expect(getDriver("claude")).toBeInstanceOf(ClaudeCodeDriver);
  });

  it("returns ClaudeCodeDriver for 'claude-code'", () => {
    expect(getDriver("claude-code")).toBeInstanceOf(ClaudeCodeDriver);
  });

  it("returns AiderDriver for 'aider'", () => {
    expect(getDriver("aider")).toBeInstanceOf(AiderDriver);
  });

  it("returns OpenAICompatibleDriver for 'openai'", () => {
    expect(getDriver("openai")).toBeInstanceOf(OpenAICompatibleDriver);
  });

  it("returns OpenAICompatibleDriver for 'openai-compatible'", () => {
    expect(getDriver("openai-compatible")).toBeInstanceOf(OpenAICompatibleDriver);
  });

  it("returns OpenAICompatibleDriver for 'qwen'", () => {
    expect(getDriver("qwen")).toBeInstanceOf(OpenAICompatibleDriver);
  });

  it("returns OpenAICompatibleDriver for 'kimi'", () => {
    expect(getDriver("kimi")).toBeInstanceOf(OpenAICompatibleDriver);
  });

  it("returns OpenAICompatibleDriver for 'deepseek'", () => {
    expect(getDriver("deepseek")).toBeInstanceOf(OpenAICompatibleDriver);
  });

  it("returns OpenAICompatibleDriver for 'pi'", () => {
    expect(getDriver("pi")).toBeInstanceOf(OpenAICompatibleDriver);
  });

  it("returns GeminiDriver for 'gemini'", () => {
    expect(getDriver("gemini")).toBeInstanceOf(GeminiDriver);
  });

  it("returns AmpDriver for 'amp'", () => {
    expect(getDriver("amp")).toBeInstanceOf(AmpDriver);
  });

  it("returns CodexDriver for 'codex'", () => {
    expect(getDriver("codex")).toBeInstanceOf(CodexDriver);
  });

  it("throws a descriptive error for unknown driver names", () => {
    expect(() => getDriver("unknown-driver")).toThrow(/Unknown agent driver/);
    expect(() => getDriver("unknown-driver")).toThrow(/unknown-driver/);
  });

  it("error message for unknown driver includes the list of valid drivers", () => {
    expect(() => getDriver("bad")).toThrow(/Valid drivers/);
  });
});

describe("getDriverStatus", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    // Save and clear relevant env vars
    for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_TOKEN",
                     "OPENAI_API_KEY", "QWEN_API_KEY", "KIMI_API_KEY", "DEEPSEEK_API_KEY",
                     "PI_API_KEY", "GEMINI_API_KEY", "AMP_API_KEY"]) {
      origEnv[k] = process.env[k];
      delete process.env[k];
    }
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns an array with an entry for each known driver", () => {
    const status = getDriverStatus();
    expect(Array.isArray(status)).toBe(true);
    expect(status.length).toBeGreaterThan(0);
    for (const entry of status) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.available).toBe("boolean");
      expect(typeof entry.note).toBe("string");
    }
  });

  it("includes an entry for 'claude'", () => {
    const status = getDriverStatus();
    const entry = status.find((s) => s.name === "claude");
    expect(entry).toBeDefined();
  });

  it("includes entries for all openai-compatible drivers", () => {
    const status = getDriverStatus();
    for (const name of ["openai", "qwen", "kimi", "deepseek", "pi"]) {
      expect(status.find((s) => s.name === name)).toBeDefined();
    }
  });

  it("includes entries for gemini, amp, codex", () => {
    const status = getDriverStatus();
    for (const name of ["gemini", "amp", "codex"]) {
      expect(status.find((s) => s.name === name)).toBeDefined();
    }
  });

  it("marks claude as unavailable when binary not found", () => {
    mockExistsSync.mockReturnValue(false);
    const status = getDriverStatus();
    const claude = status.find((s) => s.name === "claude")!;
    expect(claude.available).toBe(false);
    expect(claude.note).toContain("not found");
  });

  it("marks claude as available when binary is found", () => {
    mockExistsSync.mockImplementation((p: string) => p === "/mock/bin/claude");
    const status = getDriverStatus();
    const claude = status.find((s) => s.name === "claude")!;
    expect(claude.available).toBe(true);
  });

  it("marks openai as unavailable when no API key set", () => {
    const status = getDriverStatus();
    const openai = status.find((s) => s.name === "openai")!;
    expect(openai.available).toBe(false);
  });

  it("marks openai as available when OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const status = getDriverStatus();
    const openai = status.find((s) => s.name === "openai")!;
    expect(openai.available).toBe(true);
  });

  it("marks qwen as available when QWEN_API_KEY is set", () => {
    process.env.QWEN_API_KEY = "qwen-key";
    const status = getDriverStatus();
    const qwen = status.find((s) => s.name === "qwen")!;
    expect(qwen.available).toBe(true);
  });

  it("marks qwen as available when only OPENAI_API_KEY is set (fallback)", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const status = getDriverStatus();
    const qwen = status.find((s) => s.name === "qwen")!;
    expect(qwen.available).toBe(true);
  });

  it("marks gemini as unavailable when binary not found", () => {
    mockExistsSync.mockReturnValue(false);
    const status = getDriverStatus();
    const gemini = status.find((s) => s.name === "gemini")!;
    expect(gemini.available).toBe(false);
  });

  it("marks aider as unavailable when binary not found", () => {
    mockExistsSync.mockReturnValue(false);
    const status = getDriverStatus();
    const aider = status.find((s) => s.name === "aider")!;
    expect(aider.available).toBe(false);
  });
});
