# Plan: Write tests for uncovered error handling, edge cases, and validation logic

## Task Restatement
Add tests for error handling paths, exception scenarios, validation logic, and boundary
conditions that are not currently covered by the test suite. Focus on actionable, specific
gaps identified by code analysis — not hypothetical integration issues.

## Approach
Extend existing test files and create one new test file with mocked Redis to cover
Redis failure fallback paths:

1. `src/swarm.test.ts` — add `parseDecomposeResponse` error paths and `buildSynthesisTask`
   boundary conditions (output truncation, empty inputs, type coercion)
2. `src/tokens.test.ts` — add Redis-unavailable paths (null Redis), boundary inputs
   (zero tokens, CLAUDE_TOKENS with internal commas)
3. `src/namespace.test.ts` — add edge cases: CWD="/", empty CC_AGENT_NAMESPACE
4. `src/store-errors.test.ts` (new) — mock Redis to test failure-to-in-memory fallback
   for JobStore and LearningsStore

## Files to Touch
- `src/swarm.test.ts` — extend (pure function tests, no new mocks needed)
- `src/tokens.test.ts` — extend (reuse existing hoisted `mockGetRedis`)
- `src/namespace.test.ts` — extend (pure function, no mocks needed)
- `src/store-errors.test.ts` — create (needs its own mock setup)
- `PLAN.md`, `TODO.md` — update

## Risks
- `vi.hoisted` mocks in tokens.test.ts must be reused, not redeclared
- Store mock must mock `./state.js` to avoid file-system side effects
- `parseDecomposeResponse` returns `[]` (not throws) for empty/filtered tasks — tests must
  reflect actual behavior, not assumed behavior
