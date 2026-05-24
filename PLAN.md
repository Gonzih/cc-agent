# Plan: Inject current date into agent preamble

## Task Restatement
`DEFAULT_PREAMBLE` is a static `const` string in `src/preamble.ts`. Agents that receive it
don't know the current date and hallucinate wrong years. Fix: convert it to a `getPreamble()`
function that injects the current ISO date/time on each call. Update every consumer.

## Approaches

### A. Keep DEFAULT_PREAMBLE as a string, prepend date in injectPreamble only
Pros: minimal change — tests don't need touching.
Cons: `getPreambleText` (used for logging) would still return the static string without date.
Also the task explicitly says to change DEFAULT_PREAMBLE itself.

### B. Make DEFAULT_PREAMBLE a JS getter via Object.defineProperty (chosen pattern for ESM re-exports)
Pros: zero consumer changes.
Cons: complex, ESM named exports can't be getters the same way; test comparisons still racy.

### C. Create getPreamble() function, remove DEFAULT_PREAMBLE const, update all usages (chosen)
Pros: explicit, clean, follows the task spec exactly.
Cons: tests that do exact `toBe(DEFAULT_PREAMBLE)` need to use fake timers so the dynamic
ISO timestamp is frozen and deterministic.

## Decision: Approach C

## Files to Touch
- `src/preamble.ts` — create `getPreamble()`, remove `DEFAULT_PREAMBLE` const,
  update `injectPreamble` and `getPreambleText` to call `getPreamble()`
- `src/agent.test.ts` — replace `DEFAULT_PREAMBLE` import+usages with `getPreamble()`,
  add `vi.useFakeTimers()` in the three describe blocks that do exact string comparison

## Risks
- Millisecond races in tests: two consecutive `getPreamble()` calls could produce different ISO
  strings if the millisecond ticks between calls. Mitigated by `vi.useFakeTimers()`.
- `toLocaleDateString` output is locale-dependent; Node uses ICU data. As long as the runtime
  has 'en-US' ICU support (it does in standard Node builds) this is fine.
