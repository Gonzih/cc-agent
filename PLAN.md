# Plan: Fix meta-agent Claude subprocess piped-stdin approach

## Task Restatement
The current `MetaAgentManager` spawns a persistent `claude` process with piped stdio,
then polls a Redis input queue and writes messages to `proc.stdin`. This approach silently
hangs at 0% CPU because `claude` with piped stdin produces zero output.

The fix: replace the persistent process model with **per-message `claude -p` invocations**
so each call to `messageMetaAgent` spawns a fresh `claude -p <content>` that exits when done.

## Approaches Considered

### A: Per-message `claude -p` (chosen)
- Spawn `claude [--continue] -p <message> --dangerously-skip-permissions` per message
- Use `--continue` if a prior `.jsonl` session file exists in `~/.claude/projects/<encoded-cwd>/`
- Capture stdout, publish to Redis when process exits
- **Pros**: Matches how `claude` actually works; session continuity via `--continue`
- **Cons**: Higher process overhead per message; no real-time streaming mid-message

### B: Interactive PTY
- Spawn claude in a PTY so it thinks it has a terminal
- **Cons**: Requires `node-pty` dependency; complex; fragile

### C: Claude SDK / API
- Use the Claude API directly instead of the CLI
- **Cons**: Changes the auth model; requires API key plumbing; much larger refactor

## Approach Chosen: A

## Files to Touch
- `src/meta-agent.ts` — rewrite core spawning/polling logic
- `src/meta-agent.test.ts` — update tests for new behavior

## Key Changes

### Remove
- `this.processes` Map (persistent process tracking)
- `this.pollers` Map (Redis input poller)
- `INPUT_POLL_INTERVAL_MS` constant
- `proc.stdin?.write(...)` initial message
- `setInterval` input poller
- `process.kill(priorState.pid, 0)` orphan detection

### Add
- `this.activeProcesses` Map — tracks in-flight per-message processes
- `hasExistingSession(cwd)` — checks `~/.claude/projects/<encoded-cwd>/` for `.jsonl` files
- Per-message spawn in `messageMetaAgent`

### Status change
- `"stopped"` → `"idle"` (agents persist between messages, they're just not actively spawning)
- `MetaAgentInfo.status: "running" | "idle"` 

## Risks
- `--continue` requires at least one prior completed session. On very first message, no session
  file exists → correct fallback to fresh `-p` invocation.
- If `claude -p` exits non-zero, error is logged but not propagated to caller (fire-and-forget
  spawning is intentional to match prior behavior).
- Tests: many existing tests need rewriting since spawn is now in `messageMetaAgent`, not
  `startMetaAgent`. `readdirSync` must be added to the fs mock.
