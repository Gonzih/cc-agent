# Plan: Preamble Observability + Task Scope Warning + Context Overflow Retry

## Task Restatement
Add three focused reliability improvements to cc-agent:
1. Log the injected preamble to job output; add `custom_preamble` and `no_preamble` opts to spawn_agent MCP
2. Emit a warning when a task is large (>800 chars) and not decomposed via create_plan
3. Auto-retry once when a non-zero exit is accompanied by context-overflow signals in output

## Approach
Minimal, surgical edits across 5 files. No new files needed. All backward compatible.

### Change 1 – Preamble observability
- `preamble.ts`: add optional `noPreamble` param to `injectPreamble(task, custom?, noPreamble?)`  
  — returns raw task when `noPreamble=true`
- `types.ts`: add `noPreamble?: boolean` to `SpawnOptions` and `Job`
- `store.ts`: add `noPreamble?: boolean` to `JobRecord`
- `agent.ts` (`toRecord`/`fromRecord`): thread new field through
- `agent.ts` (`run()`): before spawning driver, compute effective preamble, log first 100 chars as  
  `[cc-agent:preamble] <snippet>...`, then pass full preamble+task to driver
- `index.ts`: add `custom_preamble` and `no_preamble` params to spawn_agent tool schema + handler

### Change 2 – Task scope warning
- `agent.ts` (`spawn()`): after job object is created, check `opts.task.length > 800`; if so emit  
  `[cc-agent:warn] Task is large (N chars). Consider using create_plan ...` to job output

### Change 3 – Context overflow retry
- `agent.ts`: add `CONTEXT_OVERFLOW_PATTERNS` regex array
- `types.ts`: add `retryCount?: number` to `Job`; `store.ts` `JobRecord` likewise
- `agent.ts` (`run()`): add `contextOverflowRetryRequested` flag; in `exit` handler, when code≠0  
  and `(job.retryCount ?? 0) < 1` and overflow detected → set flag + resolve instead of reject;  
  after Promise, if flag set: log retry message, increment `retryCount`, call `run()` again with  
  `job.continueSession = false`

## Files to Touch
- `src/preamble.ts` — noPreamble support
- `src/types.ts` — new fields on Job + SpawnOptions
- `src/store.ts` — new fields on JobRecord
- `src/agent.ts` — preamble log, scope warning, overflow retry, toRecord/fromRecord
- `src/index.ts` — MCP schema + handler for custom_preamble, no_preamble
- `src/agent.test.ts` — tests for all 3 changes

## Risks
- `noPreamble` must not affect existing behavior when not set (default path unchanged)
- Retry must not loop infinitely: `retryCount` gate enforces max 1 auto-retry
- Overflow detection is heuristic; false positives just cause one extra run (harmless)
