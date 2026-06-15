# Plan: LoopJob — per-job loop control flow with gate-based re-prompt

## Task restated
Add a LoopJob type and loop execution engine. When a worker job finishes, three structured
gates run before declaring success. On gate failure the worker is re-spawned with structured
feedback. Opt-in via `completion_criteria` in the spawn request.

## Approaches considered

1. **New loop controller job type** — caller spawns a "controller" job that in turn manages
   worker jobs. Clean separation but requires a new entity type and complex lifecycle.
2. **Integrate into JobManager.run() directly** — check gates inline in the run() method
   after a job finishes; re-call run() with updated task on failure. Minimal new surface area,
   uses existing retry pattern, but makes run() even larger.
3. **Separate LoopEngine in loop.ts called from run()** — extracted helper class, called from
   run() after success. Clean separation, easily testable, no new entity type.

**Chosen: Approach 3.** `loop.ts` contains all gate logic; `agent.ts` calls it at the right
point in the lifecycle. Existing one-shot jobs are completely unaffected.

## Files to touch
- `src/types.ts` — add JobStatus `loop_exhausted`/`loop_stalled`, `GateFailure` interface,
  loop fields to `SpawnOptions` and `Job`
- `src/loop.ts` — NEW: LoopEngine with three gate implementations
- `src/loop.test.ts` — NEW: comprehensive tests for all gates
- `src/agent.ts` — call runLoopGates() after successful run; add loop fields to toRecord/fromRecord
- `src/store.ts` — add loop fields to JobRecord
- `src/index.ts` — add loop params to spawn_agent tool input schema

## Key design decisions
- Loop state is stored ON the job itself (iteration, gateFailures, loopOutputHash, goal,
  completionCriteria, qualityRubric, maxIterations). No separate entity.
- Re-iteration = re-call run() with `job.workDir = undefined` (forces fresh clone) and
  `job.task` augmented with gate feedback.
- Quality gate spawns eval agent via manager.spawn(); waits for completion via polling.
  Eval agent returns `GATE_EVAL: {...json...}` line in output.
- Completion gate: run each criterion as `sh -c <cmd>` in workDir; any non-zero = fail.
- Reality gate: skipped gracefully (no-op) unless a repoContext defines a check command.
  For now, always passes (spec says "skip gracefully when no check defined").
- No-progress detection: sha256 of last 50 output lines. If two consecutive hashes match
  → `loop_stalled`.
- Max iterations hard cap: 3.
- Loop exhausted → status `loop_exhausted` → coordinator notifies for human hand-off.

## Risks
- Recursive run() calls need careful stack management (same as existing retry pattern — OK)
- Eval agent needs to complete before re-spawning: use `await waitForJob()` with timeout
- workDir deletion (deferred 10min) means the previous iteration's dir lives briefly after
  we force a re-clone; this is fine — rm is deferred and paths are unique per clone
