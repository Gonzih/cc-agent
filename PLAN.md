# Plan: Inject cc-agent MCP into every agent workspace

## Task Restatement
Every Claude Code session launched by cc-agent (both job agents and meta-agents) should
have the cc-agent MCP server available in the workspace `.mcp.json`. Currently only repos
that manually add it get access. We want all spawned agents to be able to call cc-agent
tools (spawn_agent, etc.) without any manual setup.

## Approach

### Option A: Inject in claude.ts (runClaude)
- Pro: one injection point for all Claude-based drivers
- Con: `runClaude` doesn't know the repo key / namespace; would need it passed as a new param,
  rippling changes through driver interface and all callers

### Option B: Inject in agent.ts (before driver.spawn) + meta-agent.ts (before spawn)
- Pro: both call sites already have `workDir`/`cwd` and a namespace/repoUrl — zero interface changes
- Con: two injection points, but they're already the two distinct code paths

### Option C: Inject as a post-clone step in agent.ts only; skip meta-agents
- Pro: simplest diff
- Con: meta-agents would still lack MCP access — violates the goal

**Chosen: Option B** — inject at both spawn sites, keep changes local to each file.

## Implementation

### New file: `src/mcp-inject.ts`
```
injectMcpConfig(cwd: string, namespace: string): void
```
- Read `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_TOKENS` via `loadTokens()[0]`
- If no token: log and return (graceful skip)
- Read `.mcp.json` in `cwd` (or start with `{mcpServers:{}}`)
- Add/overwrite `mcpServers["cc-agent"]` with npx entry + env
- Write back — never removes existing entries

### In `src/agent.ts`
- Call `injectMcpConfig(workDir!, repoKeyFromUrl(job.repoUrl))` just before `driver.spawn()`
- `repoKeyFromUrl`: parse last two path segments of repoUrl (e.g. `gonzih/cc-tg`)

### In `src/meta-agent.ts`
- Call `injectMcpConfig(cwd, namespace)` just before `spawn("claude", claudeArgs, ...)`

## Files to Touch
- `src/mcp-inject.ts` (new)
- `src/mcp-inject.test.ts` (new)
- `src/agent.ts` (~line 902)
- `src/meta-agent.ts` (~line 239)

## Risks
- Token changes: we always use `loadTokens()[0]` (the server's first token), not the
  per-job rotated token — this is intentional: injected MCP uses the server credential
- If `.mcp.json` is malformed JSON: we log and overwrite with a clean entry
- Race condition: two jobs in the same workDir — workDirs are unique temp dirs so no conflict
- meta-agent workDir: shared across messages — concurrent writes are possible but rare
  and last-write-wins is acceptable for an idempotent config entry
