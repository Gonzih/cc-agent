# Test Coverage Report — `@gonzih/cc-agent`

Generated: 2026-05-25 | Test framework: Vitest v8 coverage

## Executive Summary

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Passing tests | ~312 | **590** | +278 |
| Test files | 14 | **28** | +14 |
| Statement coverage | 45.2% | **64.7%** | +19.5pp |
| Branch coverage | 48.5% | **54.2%** | +5.7pp |
| Function coverage | 44.0% | **62.1%** | +18.1pp |
| Line coverage | — | **66.0%** | — |

Coverage went from ~45% to ~65% across the board. All 590 tests pass.

---

## PRs Merged (in order)

| PR | Branch | Tests added | Key changes |
|----|--------|-------------|-------------|
| [#116](https://github.com/Gonzih/cc-agent/pull/116) | feat/fix-coverage-reporting | 12 (fixes) | Fixed `redis.del` mock in meta-agent.test.ts; enabled vitest coverage config with text+html+json-summary reporters |
| [#117](https://github.com/Gonzih/cc-agent/pull/117) | feat/coverage-report | — | Added coverage-report.json + coverage-report.csv artifacts to repo |
| [#118](https://github.com/Gonzih/cc-agent/pull/118) | feat/test-coverage | +119 | New test files: evaluator, profiles, aider, gemini, amp, codex drivers |
| [#119](https://github.com/Gonzih/cc-agent/pull/119) | feat/error-path-tests | +57 | Error-handling paths: swarm, tokens, namespace, store-errors (Redis-failure fallback) |
| [#120](https://github.com/Gonzih/cc-agent/pull/120) | feat/add-branch-tests | +70 | Branch coverage: evaluator, store (ProfileStore/PlanStore), coordinator |
| [#121](https://github.com/Gonzih/cc-agent/pull/121) | feat/unit-tests-coverage | +various | Unit tests for preamble, redis, all driver modules, drivers-index |
| [#122](https://github.com/Gonzih/cc-agent/pull/122) | feat/integration-tests | +~30 | Integration tests for MCP API (index.ts), store round-trips, cron lifecycle |

---

## Per-File Coverage (final state)

### `src/` — Overall: 61.98% Stmts | 51.92% Branch | 58.61% Funcs | 63.08% Lines

| File | % Stmts | % Branch | % Funcs | % Lines | Notes |
|------|---------|---------|---------|---------|-------|
| `evaluator.ts` | **100** | **100** | **100** | **100** | Fully covered |
| `namespace.ts` | **100** | **100** | **100** | **100** | Fully covered |
| `preamble.ts` | **100** | **100** | **100** | **100** | Fully covered |
| `profiles.ts` | **100** | **100** | **100** | **100** | Fully covered |
| `seeds.ts` | **100** | **100** | **100** | **100** | Fully covered |
| `tokens.ts` | **100** | **100** | **100** | **100** | Fully covered |
| `logger.ts` | 97.6 | 85.7 | **100** | **100** | Lines 12, 60 |
| `state.ts` | 96.2 | **100** | **100** | 95.5 | Line 60 |
| `mcp-inject.ts` | 95.8 | 70.0 | **100** | 95.7 | Line 25 |
| `meta-agent.ts` | 85.9 | 73.1 | 54.5 | 88.5 | Lines 401,412,440,455 |
| `store.ts` | 81.7 | 82.3 | 96.4 | 83.0 | Lines 351,364,385–388 |
| `cron.ts` | 81.8 | 68.1 | 72.7 | 87.1 | Lines 230–234,261,347 |
| `docker.ts` | 79.4 | 57.5 | 63.6 | 81.4 | Lines 237,250,268–270 |
| `coordinator.ts` | 89.0 | 79.7 | 76.9 | 92.1 | Lines 80,113,139–143 |
| `redis.ts` | 61.8 | 56.3 | 66.7 | 63.5 | Lines 62–70,94–98,106–110 |
| `agent.ts` | 57.4 | 55.6 | 49.5 | 57.9 | Lines up to 1573 |
| `index.ts` | 46.4 | 27.5 | 15.6 | 49.1 | Lines up to 2017 |
| `swarm.ts` | 21.6 | 23.8 | 32.0 | 21.4 | Lines 149–212, 301–552 |
| `claude.ts` | 19.5 | 15.1 | 36.4 | 18.4 | Lines 50–180, 197–216 |
| `types.ts` | 0 | 0 | 0 | 0 | Type-only file — no runtime code |

### `src/drivers/` — Overall: 76.54% Stmts | 61.70% Branch | 75.90% Funcs | 79.04% Lines

| File | % Stmts | % Branch | % Funcs | % Lines | Notes |
|------|---------|---------|---------|---------|-------|
| `pricing.ts` | **100** | **100** | **100** | **100** | Fully covered |
| `index.ts` | **100** | 66.7 | **100** | **100** | Branch gaps lines 73,81–94,118–155 |
| `aider.ts` | 87.5 | 77.8 | 83.3 | 90.9 | Lines 66–71 |
| `amp.ts` | 86.2 | 77.0 | 69.2 | 89.5 | Lines 103,113,125–126 |
| `gemini.ts` | 84.7 | 68.2 | 69.2 | 89.1 | Lines 102,112,124–125 |
| `codex.ts` | 87.7 | 80.6 | 83.3 | 90.9 | Lines 69–74 |
| `claude-code.ts` | 69.0 | 54.5 | 83.3 | 69.7 | Lines 24–35,62–63,76 |
| `openai-compatible.ts` | 45.8 | 23.2 | 68.8 | 47.3 | Lines 151–353,368–418 |
| `types.ts` | 0 | 0 | 0 | 0 | Type-only file — no runtime code |

---

## What Was Added

### New test files (14 added across the swarm)

| File | Tests | What's covered |
|------|-------|----------------|
| `src/evaluator.test.ts` | 30 | All `buildEvaluatorTask` combos (branchEval × branchSelect), edge cases |
| `src/preamble.test.ts` | ~20 | `getPreamble`, `isCodeTask`, `isComplexTask`, `injectPreamble`, date injection |
| `src/profiles.test.ts` | 25 | `interpolate()` (8 cases), `ProfileStore` delegate wrappers |
| `src/redis.test.ts` | 8 | `initRedis`/`getRedis` lifecycle with mocked ioredis |
| `src/store-errors.test.ts` | 21 | `JobStore`/`LearningsStore` Redis-failure → in-memory fallback |
| `src/drivers/__tests__/aider.test.ts` | 15 | AiderDriver: stdout buffering, stderr, kill, token mapping |
| `src/drivers/__tests__/gemini.test.ts` | 19 | GeminiDriver: NDJSON parsing (content/tool/usage/error/usageMetadata/candidates) |
| `src/drivers/__tests__/amp.test.ts` | 27 | AmpDriver: Claude-compat NDJSON (message_start, delta, result, assistant, session_id) |
| `src/drivers/__tests__/codex.test.ts` | 21 | CodexDriver: plain-text stdout, CLI args, kill, writeStdin |
| `src/drivers/__tests__/drivers-index.test.ts` | 15 | `getDriver` (all 12 aliases + unknown throws), `listDrivers`, `getDriverStatus` |

### Existing test files extended

| File | Tests added | Coverage area |
|------|-------------|---------------|
| `src/swarm.test.ts` | 21 | `parseDecomposeResponse` error paths, `buildSynthesisTask` truncation/boundary |
| `src/tokens.test.ts` | 14 | Null-Redis fallback, zero tokens, comma-only `CLAUDE_TOKENS` |
| `src/namespace.test.ts` | 6 | `CWD="/"`, empty `CC_AGENT_NAMESPACE`, single-segment CWD |
| `src/store.test.ts` | 35 | `ProfileStore`, `PlanStore` (mocked Redis), `JobStore.updateJob`, `JobStore.loadAll` |
| `src/coordinator.test.ts` | 18 | Tombstoned entries, notify resilience, failed-status no-spawn, null-Redis start |
| `src/index.test.ts` | 30 | Profile CRUD tools, cron lifecycle, infrastructure tools, schema completeness |

### Bug fixed
- `src/meta-agent.test.ts`: Added `del: vi.fn()` to the redis mock — `startMetaAgent` calls `redis.del()` but the mock was missing it, causing 12 pre-existing test failures.

### Build/config changes
- `vitest.config.ts`: Added `reporter: ["text", "json-summary", "html"]`, `reportsDirectory: "./coverage"`, `all: true`, `fileParallelism: false` (prevents Redis flush race conditions between parallel workers)

---

## What Remains Uncovered and Why

### `swarm.ts` — 21.6% statements

**Uncovered**: `decomposeGoal()`, `buildSynthesisTask()` (with LLM streaming), `runSwarm()`, `saveSwarm()`, `loadSwarm()`, `swarmStatusKey()`.

**Why**: These functions call out to `runClaude()` (live Claude API) or depend on live Redis round-trips with complex streaming. Testing them requires either a real API key + network, or a deeply nested mock of the Claude streaming event emitter. The pure helper sub-functions (`buildDecomposePrompt`, `validateTasks`, `parseDecomposeResponse`) are well-covered; the orchestration layer is not.

### `claude.ts` — 19.5% statements

**Uncovered**: `runClaude()`, `runClaudeStreaming()`, and the NDJSON streaming event handlers.

**Why**: `runClaude` spawns a real `claude` CLI subprocess and parses its output. Without an actual `claude` binary in the test environment, these tests require a heavyweight process mock that simulates the full streaming protocol. The `resolveClaude()` helper is covered (mocked in other tests).

### `index.ts` (MCP server) — 46.4% statements, 15.6% functions

**Uncovered**: ~27 MCP tool handler functions (`spawn_agent`, `get_job_output`, `approve_job`, `cancel_job`, `work_on_issue`, `message_meta_agent`, `set_job_score`, `search_jobs`, `export_jobs`, `get_cost_report`, `list_model_ratings`, `send_message` to active jobs, etc.)

**Why**: Each handler calls into `agent.ts` or `meta-agent.ts` which spawn real subprocesses or require live Redis. The integration tests added cover ~30 handlers via the MCP protocol layer, but the ones that require a running agent process remain untested.

### `agent.ts` — 57.4% statements

**Uncovered**: `spawnAgent()` internals (git clone, subprocess management), `cancelJob()`, `wakeJob()`, `approveJob()`, budget tracking, `processClaudeOutput()` streaming paths.

**Why**: Full agent lifecycle tests require a git repo to clone and a real `claude` subprocess. The existing tests mock these at the driver level, leaving the agent orchestration layer partially covered.

### `drivers/openai-compatible.ts` — 45.8% statements

**Uncovered**: The full streaming response parser (lines 151–353), retry/error paths (368–418).

**Why**: This driver is used by Gemini-via-OpenAI-compat API. It requires an HTTP server mock emitting SSE chunks. This is testable but was not prioritized given the other drivers (native Gemini, Amp) had similar coverage already addressed.

### `drivers/claude-code.ts` — 69.0% statements

**Uncovered**: Lines 24–35 (binary resolution fallback paths), 62–63 (error event), 76 (edge case in env building).

**Why**: Already at 69% — the main happy paths are covered. The uncovered lines are minor fallback paths in binary resolution.

### `types.ts` / `drivers/types.ts` — 0%

**Why**: These files contain only TypeScript type definitions and interfaces. There is no executable JavaScript code — the 0% coverage is expected and correct.

---

## Key Technical Patterns Discovered

- **vi.hoisted() required** for `vi.mock()` factories that reference top-level variables — plain `const` declarations are not in scope when the hoisted factory runs
- **Arrow functions cannot be used as constructors** — `vi.fn(() => ...)` fails with `new`; use `vi.fn(function() { ... })` for class mocks (e.g., ioredis `Redis`)
- **fileParallelism: false** needed when tests share Redis DB — parallel workers' `afterEach` flushes interfere with in-flight tests in other workers
- **PlanStore has no in-memory fallback** — `savePlan` silently no-ops without Redis; test with `vi.spyOn(redisModule, "getRedis").mockReturnValue(mockRedis)` + `spy.mockRestore()` in afterEach
- **vitest v8 coverage requires explicit config** — without `reporter`, `reportsDirectory`, `all: true`, the coverage table is silently suppressed even on full pass

---

## Remaining Test Gaps Summary

| Priority | File | Gap | Effort to close |
|----------|------|-----|-----------------|
| High | `swarm.ts` | decomposeGoal/runSwarm orchestration | Medium — needs Claude stream mock |
| High | `claude.ts` | runClaude streaming | Medium — needs subprocess mock |
| High | `index.ts` | 27 MCP handlers | Low–Medium — most can be tested with mocked agent manager |
| Medium | `agent.ts` | spawnAgent/cancelJob/wakeJob | High — needs git+subprocess |
| Medium | `drivers/openai-compatible.ts` | SSE stream parser | Medium — needs HTTP mock server |
| Low | `claude-code.ts` | Minor fallback paths | Low |
| None | `types.ts`, `drivers/types.ts` | Type-only files | N/A |
