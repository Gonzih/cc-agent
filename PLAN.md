# Plan: Migrate cc-agent off hardcoded Redis channel strings onto @gonzih/cc-wire

## Task Restatement
Every Redis key/channel string with the `cca:` prefix is currently hardcoded in cc-agent
source files. We need to replace them all with imports from `@gonzih/cc-wire`, which is
the single source of truth for Redis key patterns across the cc-* suite. This is a pure
string-constant refactor — zero behavior change.

## Approaches

### Option A: Global search-replace with sed
- Pro: fast for simple patterns
- Con: brittle for template literals, misses import wiring, hard to verify

### Option B: File-by-file manual edit with full import wiring
- Pro: each file's intent stays clear; imports grouped sensibly; easy to review per-file
- Con: more edits, but this is necessary for correctness

### Option C: Code-gen / AST transform
- Pro: systematic
- Con: overkill, no AST tool available, manual is fast enough given clear grep output

**Chosen: Option B** — file-by-file manual edit with full import wiring.

## Missing from cc-wire 0.1.0
- `deletedCronsKey(namespace)` → `cca:deleted-crons:${namespace}` (used in cron.ts)
- `JOB_INDEX_GLOB = "cca:jobs:*"` (used in index.ts redis.keys call)
- `JOB_INDEX_PREFIX = "cca:jobs:"` (used in index.ts key.replace call)

These must be added to cc-wire first, version bumped to 0.1.1, and published.

## Files to Touch in cc-agent
- `src/tokens.ts` — remove `TOKEN_INDEX_KEY`, import from cc-wire
- `src/namespace.ts` — remove local `jobIndexKey` impl, import from cc-wire
- `src/coordinator.ts` — remove `STREAM_KEY`, `COORDINATOR_GROUP`, import from cc-wire
- `src/meta-agent.ts` — remove `META_AGENTS_INDEX` + 5 private key builders, import from cc-wire
- `src/cron.ts` — remove `redisKey()` / `deletedKey()` methods, import from cc-wire
- `src/store.ts` — replace all `cca:job:`, `cca:profile:`, `cca:plan:`, `cca:learnings:`, `cca:profiles:index`
- `src/agent.ts` — replace `cca:job:*:output`, `cca:coordinator:plan:*`, `cca:event-stream`, `cca:job:done:*`, signal/input keys
- `src/swarm.ts` — replace `cca:swarm:*` and `cca:job:*`
- `src/index.ts` — replace coordinator plan key, job done channels, notify channels, chat channels, version key, list_active_repos patterns

## Not Migrating (out of scope)
- `"cca:*"` pubsub wildcard in index.ts — general glob, not a specific channel
- String literals inside description fields / text messages (not Redis calls)
- Numeric TTL and CAP constants (not channel strings)

## Risks
- Import cycles: cc-wire has no runtime deps so no cycle risk
- cc-wire publish may fail if npm creds unavailable — user would need to publish manually
- One missing constant (`deletedCronsKey`) must land in cc-wire before cc-agent migration
