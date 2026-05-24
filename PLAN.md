# Plan: swarm_task + get_swarm_status

## Task Restatement
Add a swarm execution system to cc-agent: `swarm_task` auto-decomposes a high-level goal into N parallel sub-tasks using the Anthropic Messages API (native fetch, no new npm deps), fans out agents, waits for all to complete in the background, then spawns a synthesis agent that produces one unified deliverable. `get_swarm_status` polls the swarm state.

## Approaches

### A. In-process background loop with setInterval
Pros: simple, no extra processes. Cons: dies on restart.

### B. Delegate to onComplete chain (existing cc-agent feature)
Pros: reuses existing infra. Cons: onComplete is a single job, not fan-in; doesn't support waiting for N parallel jobs.

### C. Background async (fire-and-forget from MCP handler) with polling loop (chosen)
Pros: matches spec exactly, keeps MCP response < 5s, uses existing patterns. Cons: state lost on restart (acceptable per spec — we just mark failed on restart).

## Decision: Approach C

## Files to Touch
- `src/swarm.ts` (new) — all swarm logic
- `src/swarm.test.ts` (new) — unit tests
- `src/index.ts` — add `swarm_task` + `get_swarm_status` tools

## Risks
- Anthropic API call may fail (no API key) — handled by failing the swarm immediately with a clear error
- Very large sub-job outputs in synthesis prompt — cap each sub-job output at 500 lines + 20k chars
- Background async dies on process restart — swarm stays "running_subs" indefinitely; acceptable, won't block anything
- Redis unavailable — swarm records stored in-memory map as fallback
