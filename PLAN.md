# Plan: Fix EPIPE storm in uncaughtException handler

## Task restated
When the MCP client disconnects, cc-agent's stdout pipe breaks. Every pending write fires
`write EPIPE`, each is caught by `uncaughtException`, logged, and the process keeps running.
This produces 150+ identical error log lines before the process is eventually killed externally.

## Approach
EPIPE on stdout = client disconnected = graceful exit. The fix is:
1. In `uncaughtException`: detect `err.code === 'EPIPE'` → `process.exit(0)`
2. In `unhandledRejection`: same check (in case EPIPE surfaces as a rejection)
3. Add `process.stdout.on('error', ...)` → `process.exit(0)` on EPIPE (catches earlier in pipe lifecycle)

This is the Node.js-idiomatic approach. No logging needed — the client is already gone.

## Files to touch
- `src/index.ts` — update the three handlers at the bottom (~line 2359-2365)

## Risks
- None significant; EPIPE is unambiguous — a broken pipe to stdout only happens when the reader
  (MCP client) is gone. There is no valid use-case where we should continue after EPIPE on stdout.
