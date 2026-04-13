# PLAN.md

## Task Summary
Replace the Haiku API-based learnings compression (added by a previous agent) with a prompting trick:
each agent session now reads existing learnings, does the work, then writes a merged+compressed
`## LEARNINGS` block at the end. cc-agent replaces the stored learnings with this block on job
completion. Zero extra API calls; the agent's own Claude session handles compression.

## Approaches

### Approach A — agent self-compresses via preamble instructions (chosen)
Inject instruction into `DEFAULT_PREAMBLE` asking agents to merge old+new into a single compressed
block. On job completion, clear old learnings and store the agent's output as the new single entry.
Pros: zero extra API calls, no Haiku dependency, no async races. Cons: relies on agent following
instructions faithfully.

### Approach B — keep Haiku API but make it optional
Keep the `compressIfNeeded` method but make it no-op when no API key. Simpler removal, but still
has dead code and the wrong architectural approach.

### Approach C — scheduled compression job
Run a separate cron that compresses periodically. More moving parts, harder to test.

## Chosen: Approach A

## Files to Touch
- `src/preamble.ts` — replace LEARNINGS section with new prompting-based instructions
- `src/agent.ts` — update `buildLearningsPreamble`, `spawn`, and end-of-job learnings storage
- `src/store.ts` — remove `compressIfNeeded` and exported constants; keep `clearLearnings`
- `src/store.test.ts` — remove tests for `compressIfNeeded` and exported constants
- `src/agent.test.ts` — update `buildLearningsPreamble` tests for new format

## Key design decisions
- Store ONLY the content after `## LEARNINGS` heading (not the heading itself)
- `getLearnings(rk, 1)` — always fetch just 1 entry (the single compressed block)
- `buildLearningsPreamble` simplified: single "## Institutional Knowledge — {rk}" block
- End-of-job: clear + add (sequential) via IIFE with `.catch()`
- Remove `compressLearnings` local helper (no longer needed)
- `extractLearnings` returns content WITHOUT the `## LEARNINGS` heading line

## Risks
- Tests import `LEARNINGS_COMPRESS_THRESHOLD` and `LEARNINGS_KEEP_RECENT` — must update imports
- `buildLearningsPreamble` tests check for "Synthesized History" / "Recent Observations" — must update
- `compressIfNeeded` is called in tests — must remove those test cases
