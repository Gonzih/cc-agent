# Plan: per-job completion pub/sub channel for zero-poll waiting

## Task Restatement
Add Redis `PUBLISH` to `cca:job:done:{job_id}` whenever a job reaches a terminal state
(done, failed, cancelled, rejected), so external coordinators can `SUBSCRIBE` instead of polling.
Also add a `wait_for_job` MCP tool that polls job status and returns when it's terminal, and
update `get_job_status` / `list_jobs` descriptions to mention the pub/sub pattern.

## Approaches Considered

### A. PUBLISH only (no wait_for_job tool)
Just add the PUBLISH and update descriptions. Simpler, but coordinators that use MCP can't
easily benefit — they'd still need to poll `get_job_status`.

### B. PUBLISH + wait_for_job using BLPOP (chosen)
- PUBLISH to `cca:job:done:{id}` (for external Redis subscribers)
- Also LPUSH to `cca:job:done:{id}:queue` (for BLPOP-based internal waiting)
- `wait_for_job` MCP tool uses BLPOP to block until done without polling
Pros: zero-poll for both MCP clients and Redis clients; atomic; no dedicated subscriber conn.
Cons: queue key needs TTL; BLPOP ties up connection for long-running jobs.

### C. PUBLISH + wait_for_job polling internally
- PUBLISH for external subscribers
- `wait_for_job` polls jobStore.getJob() every 2s up to timeout
Simpler implementation, slightly more overhead than B but still far better than caller polling.
Good enough for the MCP tool since tool calls have inherent latency anyway.

## Decision: Approach B (PUBLISH + BLPOP)
BLPOP is the right primitive: blocks with timeout, works with existing ioredis connection,
no dedicated subscriber mode needed. Clean TTL on queue key. Fallback to polling if Redis unavailable.

## Files to Touch
- `src/agent.ts` — add `publishJobDone()` method, call it at all terminal-state transitions
- `src/index.ts` — add `wait_for_job` tool definition + handler, update descriptions
- `src/agent.test.ts` — test publishJobDone fires after persistJob

## Risks and Unknowns
- For smoke-test-failed and done/failed, the `finally` block in `run()` does the final persist;
  publishJobDone must go AFTER that persist, not before.
- For rejected (approval timeout), it runs outside `run()` in a setInterval — explicit publish needed.
- For cancelled: signal poller sets cancelled, kill fires, then finally block runs and re-persists.
  The job ends up with status "done" (the `job.status = "done"` line runs after the resolved promise).
  So the publish in finally covers cancelled too.
- BLPOP queue key must have a TTL matching job record TTL to avoid leaking.
