/**
 * Integration tests using mock-claude binary.
 *
 * These tests verify:
 *   1. CLAUDE_BIN env var is honoured by resolveClaude()
 *   2. runClaude() spawns the mock, reads stream-json, emits text/result events
 *   3. The mock's exit code propagates correctly
 *   4. injectMcpConfig() writes .mcp.json before claude starts
 *
 * No real Claude binary or API key is required.
 *
 * Run via: npm run test:integration
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// Resolve the mock-claude path relative to this file.
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_CLAUDE = resolve(__dirname, "../../test/fixtures/mock-claude.js");

// ─── Helper: run once and collect events ─────────────────────────────────────

type CollectedEvents = {
  /** Text events emitted by the tail poller (may be empty on fast exits). */
  texts: string[];
  /** Raw JSONL lines from the log file — always populated after exit. */
  logLines: string[];
  exitCode: number | null;
};

async function runMock(
  task: string,
  workDir: string,
  mockEnv: Record<string, string> = {},
  timeoutMs = 8000,
): Promise<CollectedEvents> {
  // Temporarily set CLAUDE_BIN so resolveClaude() returns the mock.
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = MOCK_CLAUDE;

  // Apply any mock-specific env vars.
  const prevMockEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(mockEnv)) {
    prevMockEnv[k] = process.env[k];
    process.env[k] = v;
  }

  try {
    // Lazy import so CLAUDE_BIN is already set when resolveClaude() runs inside the module.
    const { runClaude } = await import("../../src/claude.js");

    return await new Promise<CollectedEvents>((resolve, reject) => {
      const texts: string[] = [];
      let exitCode: number | null = null;
      let logPath: string | undefined;

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`runMock timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const proc = runClaude(task, workDir, undefined, {
        jobId: `mock-test-${Date.now()}`,
      });

      // Capture logPath as soon as it's available (set synchronously in runClaude).
      logPath = (proc as unknown as { logPath?: string }).logPath;

      proc.on("text", (t: string) => { if (t.trim()) texts.push(t.trim()); });
      proc.on("exit", async (code: number | null) => {
        exitCode = code;
        clearTimeout(timer);

        // runClaude() uses file-based I/O (stdout → log file, tail poller every 500ms).
        // The fast-path proc.on("exit") kills the tail before it can read the log.
        // Read the log file directly to capture output regardless of tail timing.
        let logLines: string[] = [];
        if (logPath) {
          try {
            // Small delay for the OS to flush all buffered writes.
            await new Promise<void>((r) => setTimeout(r, 100));
            const raw = await readFile(logPath, "utf-8");
            logLines = raw
              .split("\n")
              .filter((l) => l.trim())
              .map((l) => {
                try {
                  const obj = JSON.parse(l) as Record<string, unknown>;
                  // Extract text from assistant or result messages.
                  if (obj.type === "result") return String(obj.result ?? "");
                  if (obj.type === "assistant") {
                    const msg = obj.message as { content?: unknown } | undefined;
                    const content = msg?.content;
                    if (Array.isArray(content)) {
                      return (content as Array<{ type?: string; text?: string }>)
                        .filter((b) => b.type === "text")
                        .map((b) => b.text ?? "")
                        .join("");
                    }
                    if (typeof content === "string") return content;
                  }
                  return "";
                } catch {
                  return l;
                }
              })
              .filter((l) => l.trim());
          } catch {
            logLines = [];
          }
        }

        resolve({ texts, logLines, exitCode });
      });
      proc.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    // Restore env.
    if (prev === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prev;

    for (const [k, v] of Object.entries(prevMockEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CLAUDE_BIN env var", () => {
  test("resolveClaude() returns CLAUDE_BIN when set", async () => {
    const prevBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = "/custom/mock/claude";
    try {
      const { resolveClaude } = await import("../../src/claude.js");
      const resolved = resolveClaude();
      assert.equal(resolved, "/custom/mock/claude");
    } finally {
      if (prevBin === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = prevBin;
    }
  });

  test("resolveClaude() ignores disk existence check for CLAUDE_BIN", async () => {
    const prevBin = process.env.CLAUDE_BIN;
    // Use a path that definitely doesn't exist on disk.
    process.env.CLAUDE_BIN = "/absolutely/nonexistent/mock-claude";
    try {
      const { resolveClaude } = await import("../../src/claude.js");
      const resolved = resolveClaude();
      assert.equal(resolved, "/absolutely/nonexistent/mock-claude");
    } finally {
      if (prevBin === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = prevBin;
    }
  });
});

describe("mock-claude binary sanity", () => {
  test("mock-claude.js is executable", () => {
    assert.ok(existsSync(MOCK_CLAUDE), `mock-claude not found at ${MOCK_CLAUDE}`);
  });
});

describe("runClaude() with mock binary — job lifecycle", () => {
  let workDir: string;

  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), "cc-agent-mock-test-"));
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test(
    "job completes and emits mock result text",
    { timeout: 15_000 },
    async () => {
      const { logLines, exitCode } = await runMock(
        "do something",
        workDir,
        { MOCK_CLAUDE_RESULT: "hello from mock", MOCK_CLAUDE_DELAY_MS: "50" },
      );

      assert.equal(exitCode, 0, `Expected exit code 0, got ${exitCode}`);
      assert.ok(
        logLines.some((t) => t.includes("hello from mock")),
        `Expected "hello from mock" in log output.\nGot: ${JSON.stringify(logLines)}`,
      );
    },
  );

  test(
    "default result text is 'mock result'",
    { timeout: 15_000 },
    async () => {
      const { logLines, exitCode } = await runMock(
        "do something",
        workDir,
        { MOCK_CLAUDE_DELAY_MS: "50" },
      );

      assert.equal(exitCode, 0);
      assert.ok(
        logLines.some((t) => t.includes("mock result")),
        `Expected "mock result" in log output.\nGot: ${JSON.stringify(logLines)}`,
      );
    },
  );

  test(
    "non-zero exit code is propagated",
    { timeout: 15_000 },
    async () => {
      const result = await runMock(
        "failing task",
        workDir,
        { MOCK_CLAUDE_EXIT_CODE: "1", MOCK_CLAUDE_DELAY_MS: "50" },
      );

      // Process exited with code 1 — that's what we're checking.
      assert.equal(result.exitCode, 1, `Expected exit code 1, got ${result.exitCode}`);
    },
  );
});

describe("MCP injection — .mcp.json written before claude starts", () => {
  let workDir: string;

  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), "cc-agent-mcp-test-"));
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test(
    "injectMcpConfig writes .mcp.json containing cc-agent entry",
    async () => {
      // Set a fake token so injectMcpConfig doesn't skip.
      const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token-for-mcp-inject";
      try {
        const { injectMcpConfig } = await import("../../src/mcp-inject.js");
        injectMcpConfig(workDir, "gonzih/cc-agent");

        const mcpPath = join(workDir, ".mcp.json");
        assert.ok(existsSync(mcpPath), `.mcp.json not found at ${mcpPath}`);

        const raw = await readFile(mcpPath, "utf-8");
        const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
        assert.ok(
          parsed.mcpServers?.["cc-agent"],
          `Expected "cc-agent" entry in .mcp.json mcpServers.\nGot: ${JSON.stringify(parsed, null, 2)}`,
        );
      } finally {
        if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
      }
    },
  );

  test(
    "injectMcpConfig preserves existing mcpServers entries",
    async () => {
      const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token-for-mcp-inject";
      try {
        const { injectMcpConfig } = await import("../../src/mcp-inject.js");

        // Pre-seed a .mcp.json with an existing entry.
        const mcpPath = join(workDir, ".mcp.json-preserve-test");
        const workDir2 = await mkdtemp(join(tmpdir(), "cc-agent-mcp-preserve-"));
        try {
          const preExisting = {
            mcpServers: {
              "my-custom-server": { command: "custom", args: [], env: {} },
            },
          };
          const { writeFileSync } = await import("node:fs");
          writeFileSync(join(workDir2, ".mcp.json"), JSON.stringify(preExisting, null, 2));

          injectMcpConfig(workDir2, "gonzih/cc-agent");

          const raw = await readFile(join(workDir2, ".mcp.json"), "utf-8");
          const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };

          assert.ok(
            parsed.mcpServers?.["cc-agent"],
            "cc-agent entry should be present after injection",
          );
          assert.ok(
            parsed.mcpServers?.["my-custom-server"],
            "Pre-existing my-custom-server entry should be preserved",
          );
        } finally {
          await rm(workDir2, { recursive: true, force: true });
        }
      } finally {
        if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
      }
    },
  );
});
