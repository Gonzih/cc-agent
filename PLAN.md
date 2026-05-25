# Plan: Write tests for uncovered branches in service and controller layers

## Task Restatement
Add tests for all uncovered conditional branches, error handlers, and edge cases in the
service layer (store.ts, coordinator.ts, swarm.ts) and controller layer (evaluator.ts).
The goal is to cover happy paths AND failure/edge-case branches that existing tests miss.

## Approaches

### Option A: One giant new test file per missing area
- Pro: easier to review as a group
- Con: mixes concerns, harder to discover in relation to source files

### Option B: Extend existing test files + add evaluator.test.ts
- Pro: keeps tests co-located with source, follows established pattern
- Con: none — this is the standard pattern

### Option C: Integration test approach (real Redis)
- Pro: tests real Redis paths
- Con: slower, depends on Redis availability; unit tests already cover Redis paths adequately

**Chosen: Option B** — extend existing tests + new evaluator.test.ts

## Coverage Targets

### src/evaluator.ts — NEW evaluator.test.ts
No tests at all. Need:
- `buildEvaluatorTask` with all 3 × 3 = 9 combinations of branchEval × branchSelect
- Variant list with and without branch names
- WINNER output format present in task text
- Correct variant count in text

### src/swarm.test.ts — EXTEND
Existing tests cover parseDecomposeResponse + buildSynthesisTask happy paths. Missing:
- `buildSynthesisTask` with >500 output lines (truncation logic)
- `buildSynthesisTask` with output exceeding 20,000 chars (char-limit branch)
- `parseDecomposeResponse` with non-object array items (filtered out)
- `buildSynthesisTask` with empty outputs array

### src/store.test.ts — EXTEND
Existing tests cover JobStore namespace isolation + LearningsStore. Missing:
- `JobStore.updateJob` when job doesn't exist (no-op / silently skipped)
- `JobStore.updateJob` merges partial fields
- `JobStore.loadAll` returns jobs from Redis when present
- `JobStore.loadAll` falls back to disk when Redis returns nothing
- `ProfileStore.saveProfile`, `getProfile`, `listProfiles`, `deleteProfile` (no tests!)
- `ProfileStore.listProfiles` migration: empty Redis → migrates disk profiles
- `ProfileStore.deleteProfile` on non-existent name → returns false
- `PlanStore.savePlan` + `getPlan` (no tests!)
- `PlanStore.getPlan` with non-existent ID → null

### src/coordinator.test.ts — EXTEND
Existing tests cover processEvent, poll, start/stop, notify. Missing:
- `replayMissedEvents` skipping entries with empty fields array
- `notify` when redis `publish` throws (logs warn, doesn't throw)
- `processEvent` with invalid/non-parseable repoUrl (uses raw string)
- `processEvent` with status other than done/failed (no notification)
- `start()` when redis is null (no xgroup call)
- `stop()` before start() (no-op, no crash)
- `processEvent` coordinatorPlan set but status is failed (no spawn, but notifies)

## Files to Touch
- `src/evaluator.test.ts` (new)
- `src/swarm.test.ts` (extend)
- `src/store.test.ts` (extend)
- `src/coordinator.test.ts` (extend)

## Risks
- ProfileStore disk operations require mocking `fs` (existsSync, readFileSync, writeFileSync)
  or letting them hit the real disk (safer — test cleanup via afterEach)
- PlanStore has no disk fallback, so only Redis path is testable
- Redis test isolation via flushdb in test-setup.ts is already in place
