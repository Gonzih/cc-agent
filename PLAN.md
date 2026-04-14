# Plan: Fix WRONGTYPE Redis error and orphaned process on restart

## Task Restatement
Fix two bugs in `src/meta-agent.ts`:

1. **Bug 1**: `messageMetaAgent` calls `redis.hset(metaKey(namespace), ...)` but `metaKey(namespace)` is stored as a STRING by `saveState`. Redis throws `WRONGTYPE` when mixing hash ops on a string key.

2. **Bug 2**: After cc-agent restarts, `this.processes` (in-memory Map) is empty. `startMetaAgent` sees no tracked process and spawns a new Claude process, leaving the prior one as an orphan.

## Approach

### Bug 1: Replace hset with read-modify-write via getState/saveState
- Remove the `hset` call entirely
- Read current state with `getState(namespace)`, set `lastMessageAt`, write back with `saveState`
- **Pros**: Consistent with the existing string-key pattern; no type mismatch
- **Cons**: One extra Redis GET per message (acceptable)

### Bug 2: Kill orphaned process before spawning
- After `getState` in `startMetaAgent`, check if `priorState.pid` is alive via `process.kill(pid, 0)`
- If alive (no throw): kill it with `process.kill(pid)` to avoid leak, then spawn fresh
- If dead (throws ESRCH): proceed to spawn fresh as normal
- **Pros**: Minimal change, no complex re-adoption logic, prevents leak
- **Cons**: Prior process output is lost (acceptable; it was orphaned anyway)

## Files to Touch
- `src/meta-agent.ts` — apply both fixes
- `src/meta-agent.test.ts` — update hset test; add orphan-kill tests

## Risks
- `process.kill(pid, 0)` may throw for non-ESRCH reasons (EPERM) — catch all errors to be safe
- Test uses `vi.spyOn(process, 'kill')` — must restore spy after each test
