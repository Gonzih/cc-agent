# Plan: Fix start_meta_agent crash on first-time start

## Task Restatement
`startMetaAgent` always passes `--continue` to Claude, which requires a prior deferred session.
On first start for a namespace, there is no prior session, so Claude immediately exits with:
"Error: No deferred tool marker found in the resumed session."

Fix: check if a prior session exists (via Redis state lookup) before deciding which args to pass.

## Approach

### Chosen: Redis state heuristic
- Before spawning Claude, call `getState(namespace)` to check if a prior session record exists in Redis
- If state exists (namespace was started before) → pass `["--continue"]`
- If state is null (first time) → pass `[]` (no --continue), and write an initial system prompt to stdin
- **Pros:** Uses existing Redis infrastructure, no new deps, minimal code change
- **Cons:** If Redis is wiped, treated as first-time (acceptable — Claude starts fresh)

### Rejected: filesystem session file check
- Claude stores sessions in ~/.claude/projects/{hash}/ — hash computation is complex
- Fragile if Claude changes its storage location

### Rejected: explicit flag in Redis metadata
- Would require storing a separate "session-initialized" key
- The existing state record already serves as that signal

## Files to Touch
- `src/meta-agent.ts` — conditional `--continue` logic + initial stdin prompt
- `src/meta-agent.test.ts` — update existing test, add new test cases

## Risks
- `getState()` is called twice if already-running branch is taken (acceptable, it's a Redis GET)
- Initial stdin prompt format may not match what Claude expects — kept minimal and safe
