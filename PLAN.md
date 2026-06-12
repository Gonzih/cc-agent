# Plan: Fix MCP subprocess stealing meta-agent input queue messages

## Task restated
MCP subprocess cc-agent instances (spawned by Claude sessions) start polling META_AGENTS_INDEX
and compete with the launchd-blessed instance for input queue messages. They consume messages
but fail to process them (no OAuth token), causing Discord/Telegram messages to be lost silently.

## Fix
Add a single guard at the top of `pollInputQueues()` in `src/meta-agent.ts`:

```ts
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.CLAUDE_TOKENS) return;
```

Signal logic:
- launchd plist sets `CLAUDE_CODE_OAUTH_TOKEN` in the service environment
- MCP subprocesses do NOT inherit this env var (Claude Code strips CLAUDE_* vars)
- `CLAUDE_TOKENS` is the legacy multi-token env var — also check it for completeness

## Files to touch
- `src/meta-agent.ts` — add guard as first statement in `pollInputQueues()`
- `src/meta-agent.test.ts` — set env var in poller tests; add guard behavior test

## Risks
- Existing poller tests call `pollInputQueues()` directly without the env var → will become no-ops.
  Fix: set `process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token"` in the poller describe block.
- The guard is purely additive for the launchd path — no behavioral change when token is present.
