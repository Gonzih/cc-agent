import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadTokens } from "./tokens.js";
import { logger } from "./logger.js";

interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

/**
 * Derive a `org/repo` key from a git remote URL.
 * e.g. `https://github.com/gonzih/cc-tg` → `gonzih/cc-tg`
 *      `git@github.com:gonzih/cc-tg.git` → `gonzih/cc-tg`
 */
export function repoKeyFromUrl(repoUrl: string): string {
  const cleaned = repoUrl.replace(/\.git$/, "");
  const parts = cleaned.replace(":", "/").split("/");
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return cleaned;
}

/**
 * Inject the cc-agent MCP server entry into `<cwd>/.mcp.json`.
 *
 * - Non-destructive: existing mcpServers entries are preserved.
 * - Skips silently if no OAuth token is available in the server environment.
 * - Overwrites a pre-existing `cc-agent` key so the namespace stays current.
 */
export function injectMcpConfig(cwd: string, namespace: string): void {
  const tokens = loadTokens();
  if (tokens.length === 0) {
    logger.info("mcp-inject:skip", { reason: "no token available", cwd, namespace });
    return;
  }

  const token = tokens[0];
  const mcpPath = join(cwd, ".mcp.json");

  let config: McpConfig = { mcpServers: {} };
  if (existsSync(mcpPath)) {
    try {
      const raw = readFileSync(mcpPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<McpConfig>;
      config = { mcpServers: parsed.mcpServers ?? {} };
    } catch {
      // Malformed JSON — start with empty mcpServers but log a warning
      logger.warn("mcp-inject:parse-failed", { mcpPath });
      config = { mcpServers: {} };
    }
  }

  config.mcpServers["cc-agent"] = {
    command: "npx",
    args: ["@gonzih/cc-agent"],
    env: {
      CC_AGENT_NAMESPACE: namespace,
      CLAUDE_CODE_OAUTH_TOKEN: token,
      PATH: process.env.PATH ?? "",
    },
  };

  try {
    writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    logger.info("mcp-inject:done", { cwd, namespace });
  } catch (err) {
    logger.warn("mcp-inject:write-failed", { cwd, namespace, err: String(err) });
  }
}
