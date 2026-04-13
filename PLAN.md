# PLAN.md

## Task Summary
Add semantic compression to `LearningsStore`: when a namespace accumulates >= 15 entries, automatically call Claude Haiku to synthesize old entries into a single tagged bullet summary, keeping the 5 most recent raw entries. Update the preamble formatter to display compressed vs raw entries distinctly.

## Approaches

### Approach A — fire-and-forget background compression (chosen)
Hook `compressIfNeeded` into `addLearning` as a background promise. Caller is not blocked. Compression happens after write. Simple, no latency impact.

### Approach B — synchronous compression on add
Block `addLearning` until compression completes. Adds latency to every add when near threshold. Not acceptable.

### Approach C — separate scheduled compression job
Add a cron/interval that runs compression periodically. More moving parts, harder to test, possible races. Overkill for this case.

## Chosen: Approach A

## Files to Touch
- `src/store.ts` — add `compressIfNeeded`, hook into `addLearning`, export threshold constants
- `src/agent.ts` — update `buildLearningsPreamble` to show compressed/recent separately, increase getLearnings limit to 6
- `src/store.test.ts` — add tests for `compressIfNeeded` no-op path and preamble formatting

## Risks
- `fetch` is Node 18+ built-in; package targets Node 22 — fine
- API key may be absent in some deployments — handled by early return with warn log
- Compression could fail mid-write (pipeline partially executed) — DEL + RPUSH/LPUSH is not atomic across commands but pipeline is batched; acceptable risk since worst case is a loss of 1 compression attempt
- In-memory fallback path for `compressIfNeeded` returns early (no Redis → no-op) — correct behavior

## List ordering
LPUSH → newest at head. LRANGE 0 -1 → [newest, ..., oldest].
After compress: pipeline DEL + RPUSH(compressedEntry) + LPUSH(recent[N-1]) + ... + LPUSH(recent[0])
Result: [recent[0], recent[1], ..., recent[4], compressedEntry] ✓
