# Plan: Fix meta-agent token injection via Redis fallback (0.15.34)

## Task restated
When the MCP cc-agent instance starts (spawned by Claude Code from .mcp.json), Claude Code
strips CLAUDE_* env vars. So `loadTokens()` returns [] in the MCP instance. When
`messageMetaAgent` runs, it spawns `claude -p` with `env: process.env`, which has no token
→ claude exits "Not logged in".

The launchd cc-agent instance HAS the token. Fix: launchd writes its token to
`cca:token:master` in Redis at startup. MCP instance reads it as fallback via `getMasterToken()`.

## Approach
Three-file minimal change:

1. `src/tokens.ts`: add `getMasterToken()` — tries `loadTokens()[0]` first, Redis fallback
2. `src/index.ts`: at startup write master token to `cca:token:master` if tokens available
3. `src/meta-agent.ts`: call `getMasterToken()` before spawning claude, inject into env if missing

## Files to touch
- `src/tokens.ts` — add `getMasterToken()` + `MASTER_TOKEN_KEY` constant
- `src/index.ts` — write master token to Redis at startup
- `src/meta-agent.ts` — inject master token into spawn env
- `src/tokens.test.ts` — test `getMasterToken()` Redis fallback path

## Risks
- Purely additive: if `loadTokens()` has tokens (launchd instance), `getMasterToken()` returns
  them directly with no Redis call — behavior unchanged for launchd
- If MCP instance also has tokens somehow, its own env is used first
- Token in Redis could be stale if token rotates — acceptable since master token is the primary
  fallback for the tokenless MCP path, not for rotation logic
