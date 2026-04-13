# PLAN.md

## Task Summary
Add two new MCP tools (`list_active_repos`, `get_pubsub_status`) and update the coordinator notification format to use emoji icons with scores.

## Approaches

### Fix 1: list_active_repos
- **Approach A (Redis SMEMBERS + pipeline)**: Scan `cca:jobs:*` keys, fetch job records in pipeline, aggregate. Chosen — matches provided spec.
- **Approach B (Stream scan)**: Scan event stream. Too expensive and doesn't map well to namespace aggregation.

### Fix 2: get_pubsub_status
- **Approach A (PUBSUB CHANNELS + NUMSUB)**: Call `redis.pubsub("CHANNELS", "cca:*")` then `NUMSUB`. Chosen — matches spec, direct Redis introspection.
- **Approach B (Separate health check HTTP endpoint)**: Requires more infrastructure. Overkill.

### Fix 3: Coordinator notification format
- **Current state**: Already notifies ALL done and failed. Needs emoji icons (✅/❌) and score in message.
- **Approach**: Unify done/failed into single pattern with icon and optional score string. Remove the separate low-score warning (it's now embedded in score field).

## Files to Touch
- `src/index.ts` — add 2 tool definitions + 2 handlers
- `src/coordinator.ts` — update `processEvent()` notification format

## Risks
- `redis.keys("cca:jobs:*")` could be slow on large Redis instances; acceptable for now
- `PUBSUB CHANNELS` / `NUMSUB` are O(N) but cca:* scope limits it
- Coordinator test `"does not publish notification for high-score done event"` was previously inverted — must check test file to see current state
