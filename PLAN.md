# Plan: Add test coverage for untested modules

## Task Restatement
Several modules in cc-agent have zero test coverage: evaluator.ts, profiles.ts,
and four driver implementations (aider, gemini, amp, codex). The task is to write
meaningful unit tests for these modules, commit them to branch feat/test-coverage,
and push to remote.

## Approaches

### Option A: Integration tests hitting real binaries
- Pro: maximally realistic
- Con: requires binaries installed in CI, slow, brittle

### Option B: Pure unit tests with mocked subprocess and storage
- Pro: fast, hermetic, always reproducible, tests the logic we own
- Con: doesn't catch CLI flag regressions
- **Chosen** — consistent with existing test patterns in the repo

### Option C: Snapshot tests
- Pro: easy to write
- Con: brittle, doesn't validate correctness

## Files to create
- `src/evaluator.test.ts` — tests for buildEvaluatorTask + all instruction builders
- `src/profiles.test.ts` — tests for interpolate() + mocked profileStore wrappers
- `src/drivers/__tests__/aider.test.ts` — AiderDriver spawn/events/estimateCost
- `src/drivers/__tests__/gemini.test.ts` — GeminiDriver NDJSON parsing + events
- `src/drivers/__tests__/amp.test.ts` — AmpDriver Claude-compatible NDJSON parsing
- `src/drivers/__tests__/codex.test.ts` — CodexDriver plain-text output

## Risks
- child_process vi.mock hoisting: must use factory form vi.mock("child_process", () => ...)
- fs mock: must preserve non-existsSync exports via importOriginal
- profileStore mock: relative path must match profiles.ts import of ./store.js
