import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock logger so tests don't produce noisy output
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// We do NOT mock fs — we use a real temp directory so we can verify file writes.

describe("repoKeyFromUrl", () => {
  it("parses https URL", async () => {
    const { repoKeyFromUrl } = await import("./mcp-inject.js");
    expect(repoKeyFromUrl("https://github.com/gonzih/cc-tg")).toBe("gonzih/cc-tg");
  });

  it("strips .git suffix", async () => {
    const { repoKeyFromUrl } = await import("./mcp-inject.js");
    expect(repoKeyFromUrl("https://github.com/gonzih/cc-tg.git")).toBe("gonzih/cc-tg");
  });

  it("parses SSH URL", async () => {
    const { repoKeyFromUrl } = await import("./mcp-inject.js");
    expect(repoKeyFromUrl("git@github.com:gonzih/money-brain.git")).toBe("gonzih/money-brain");
  });
});

describe("injectMcpConfig", () => {
  let tmpDir: string;
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-inject-test-"));
    // Snapshot relevant env vars
    origEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    origEnv.CLAUDE_TOKENS = process.env.CLAUDE_TOKENS;
    origEnv.PATH = process.env.PATH;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Restore env
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k as keyof NodeJS.ProcessEnv];
      else process.env[k as keyof NodeJS.ProcessEnv] = v;
    }
    vi.resetModules();
  });

  async function getInject() {
    const mod = await import("./mcp-inject.js");
    return mod.injectMcpConfig;
  }

  it("creates .mcp.json when it does not exist", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-oauth-token";
    delete process.env.CLAUDE_TOKENS;
    const injectMcpConfig = await getInject();

    injectMcpConfig(tmpDir, "gonzih/cc-tg");

    const written = JSON.parse(readFileSync(join(tmpDir, ".mcp.json"), "utf-8"));
    expect(written.mcpServers["cc-agent"]).toMatchObject({
      command: "npx",
      args: ["@gonzih/cc-agent"],
      env: {
        CC_AGENT_NAMESPACE: "gonzih/cc-tg",
        CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
      },
    });
  });

  it("merges into existing .mcp.json without removing other entries", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok123";
    delete process.env.CLAUDE_TOKENS;
    const injectMcpConfig = await getInject();

    // Pre-existing config with another server
    const existing = {
      mcpServers: {
        "my-tool": { command: "node", args: ["my-tool.js"], env: {} },
      },
    };
    require("fs").writeFileSync(
      join(tmpDir, ".mcp.json"),
      JSON.stringify(existing, null, 2),
      "utf-8"
    );

    injectMcpConfig(tmpDir, "gonzih/my-repo");

    const written = JSON.parse(readFileSync(join(tmpDir, ".mcp.json"), "utf-8"));
    // Pre-existing entry still present
    expect(written.mcpServers["my-tool"]).toBeDefined();
    // cc-agent entry added
    expect(written.mcpServers["cc-agent"].env.CC_AGENT_NAMESPACE).toBe("gonzih/my-repo");
  });

  it("skips injection when no token is available", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_TOKENS;
    const injectMcpConfig = await getInject();

    injectMcpConfig(tmpDir, "gonzih/cc-tg");

    // No .mcp.json should be written
    expect(require("fs").existsSync(join(tmpDir, ".mcp.json"))).toBe(false);
  });

  it("overwrites existing cc-agent entry with updated namespace", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "new-tok";
    delete process.env.CLAUDE_TOKENS;
    const injectMcpConfig = await getInject();

    // Pre-existing cc-agent entry with stale namespace
    const existing = {
      mcpServers: {
        "cc-agent": {
          command: "npx",
          args: ["@gonzih/cc-agent"],
          env: { CC_AGENT_NAMESPACE: "old/namespace", CLAUDE_CODE_OAUTH_TOKEN: "old-tok", PATH: "" },
        },
      },
    };
    require("fs").writeFileSync(
      join(tmpDir, ".mcp.json"),
      JSON.stringify(existing),
      "utf-8"
    );

    injectMcpConfig(tmpDir, "new/namespace");

    const written = JSON.parse(readFileSync(join(tmpDir, ".mcp.json"), "utf-8"));
    expect(written.mcpServers["cc-agent"].env.CC_AGENT_NAMESPACE).toBe("new/namespace");
    expect(written.mcpServers["cc-agent"].env.CLAUDE_CODE_OAUTH_TOKEN).toBe("new-tok");
  });

  it("handles malformed .mcp.json gracefully by overwriting", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok-recovery";
    delete process.env.CLAUDE_TOKENS;
    const injectMcpConfig = await getInject();

    require("fs").writeFileSync(join(tmpDir, ".mcp.json"), "NOT VALID JSON", "utf-8");

    // Should not throw
    injectMcpConfig(tmpDir, "gonzih/cc-tg");

    const written = JSON.parse(readFileSync(join(tmpDir, ".mcp.json"), "utf-8"));
    expect(written.mcpServers["cc-agent"]).toBeDefined();
  });

  it("uses first token from CLAUDE_TOKENS when CLAUDE_CODE_OAUTH_TOKEN is unset", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_TOKENS = "token-a,token-b,token-c";
    const injectMcpConfig = await getInject();

    injectMcpConfig(tmpDir, "gonzih/cc-tg");

    const written = JSON.parse(readFileSync(join(tmpDir, ".mcp.json"), "utf-8"));
    expect(written.mcpServers["cc-agent"].env.CLAUDE_CODE_OAUTH_TOKEN).toBe("token-a");
  });
});
