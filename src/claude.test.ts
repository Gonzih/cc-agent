import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractText, resolveClaude } from "./claude.js";
import type { ClaudeMessage } from "./claude.js";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  spawn: vi.fn(),
}));

import { existsSync } from "fs";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("extractText", () => {
  it("returns result string for result type", () => {
    const msg: ClaudeMessage = {
      type: "result",
      payload: { type: "result", result: "Task complete." },
    };
    expect(extractText(msg)).toBe("Task complete.");
  });

  it("returns empty string for result type with no result field", () => {
    const msg: ClaudeMessage = {
      type: "result",
      payload: { type: "result" },
    };
    expect(extractText(msg)).toBe("");
  });

  it("returns string content from assistant message", () => {
    const msg: ClaudeMessage = {
      type: "assistant",
      payload: {
        type: "assistant",
        message: { content: "Hello there" },
      },
    };
    expect(extractText(msg)).toBe("Hello there");
  });

  it("returns concatenated text blocks from assistant message with array content", () => {
    const msg: ClaudeMessage = {
      type: "assistant",
      payload: {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Hello " },
            { type: "tool_use", name: "bash", id: "1" },
            { type: "text", text: "world" },
          ],
        },
      },
    };
    expect(extractText(msg)).toBe("Hello world");
  });

  it("returns empty string for tool_use only content", () => {
    const msg: ClaudeMessage = {
      type: "assistant",
      payload: {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "bash", id: "1" }],
        },
      },
    };
    expect(extractText(msg)).toBe("");
  });

  it("returns empty string when no message field", () => {
    const msg: ClaudeMessage = {
      type: "assistant",
      payload: { type: "assistant" },
    };
    expect(extractText(msg)).toBe("");
  });
});

describe("resolveClaude", () => {
  it("returns path from PATH when claude binary exists there", () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/custom/bin";
    vi.mocked(existsSync).mockImplementation((p) => p === "/custom/bin/claude");
    const result = resolveClaude();
    expect(result).toBe("/custom/bin/claude");
    process.env.PATH = origPath;
  });

  it("returns fallback path when not in PATH", () => {
    const origPath = process.env.PATH;
    const origHome = process.env.HOME;
    process.env.PATH = "/nonexistent/bin";
    process.env.HOME = "/home/testuser";
    vi.mocked(existsSync).mockImplementation(
      (p) => p === "/usr/local/bin/claude"
    );
    const result = resolveClaude();
    expect(result).toBe("/usr/local/bin/claude");
    process.env.PATH = origPath;
    process.env.HOME = origHome;
  });

  it("returns 'claude' when not found anywhere", () => {
    const origPath = process.env.PATH;
    const origHome = process.env.HOME;
    process.env.PATH = "/nonexistent/bin";
    process.env.HOME = "/home/testuser";
    vi.mocked(existsSync).mockReturnValue(false);
    const result = resolveClaude();
    expect(result).toBe("claude");
    process.env.PATH = origPath;
    process.env.HOME = origHome;
  });
});
