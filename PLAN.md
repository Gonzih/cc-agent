# Plan: Write unit tests for uncovered utility/helper/driver modules

## Task Restatement
Several source files have no test coverage at all: `evaluator.ts`, `preamble.ts`,
`profiles.ts`, `redis.ts`, and four driver files (`aider.ts`, `gemini.ts`, `amp.ts`,
`codex.ts`) plus `drivers/index.ts`. The goal is to write unit tests that cover all
exported functions and critical internal logic paths in these modules.

## Approaches

### Option A: Integration-style tests hitting real FS/Redis
- Pro: High fidelity
- Con: Flaky in CI (needs Redis, real binaries), slow, hard to isolate

### Option B: Mock-heavy unit tests
- Pro: Fast, isolated, hermetic, runs anywhere
- Con: Mocks can drift from real behavior; need to maintain them
- **Chosen** for all modules with external dependencies (Redis, child_process, fs)

### Option C: Hybrid — real FS for pure functions, mocks for I/O
- Pro: Best of both worlds for pure-function modules
- Con: More setup complexity
- **Used for**: preamble.ts, evaluator.ts, profiles.interpolate (pure functions tested directly)

## Files to Create
- `src/evaluator.test.ts`
- `src/preamble.test.ts`
- `src/profiles.test.ts`
- `src/redis.test.ts`
- `src/drivers/__tests__/aider.test.ts`
- `src/drivers/__tests__/gemini.test.ts`
- `src/drivers/__tests__/amp.test.ts`
- `src/drivers/__tests__/codex.test.ts`
- `src/drivers/__tests__/drivers-index.test.ts`

## Risks
- `redis.ts` has a module-level singleton (`redisClient`) — need `vi.resetModules()` + dynamic imports
- Driver tests must mock `child_process.spawn` carefully to avoid spawning real processes
- `preamble.ts` embeds `new Date()` — use `vi.useFakeTimers()` for date-sensitive assertions
- `profiles.ts` is a thin wrapper around `store.js` — mock the store, focus on `interpolate()`
