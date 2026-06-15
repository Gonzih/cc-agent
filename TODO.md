# TODO — LoopJob per-job loop control flow

- [x] Read PLAN.md, understand codebase
- [ ] git checkout -b feat/loop-job
- [ ] src/types.ts — add loop_exhausted/loop_stalled to JobStatus, GateFailure interface, loop fields to SpawnOptions and Job
- [ ] src/store.ts — add loop fields to JobRecord
- [ ] src/loop.ts — NEW: LoopEngine class with runLoopGates(), runCompletionGate(), runQualityGate(), hash helpers
- [ ] src/agent.ts — add loop fields to toRecord/fromRecord; call runLoopGates() in run() after success
- [ ] src/index.ts — add completion_criteria, quality_rubric, goal, max_iterations to spawn_agent schema
- [ ] src/loop.test.ts — NEW: comprehensive tests
- [ ] npm install && npm test
- [ ] git add + diff review + commit
- [ ] gh pr create + merge + publish
