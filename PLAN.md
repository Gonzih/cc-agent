# Plan: Fix Job Completion Notification Routing

## Task restated
When a meta-agent (e.g. simorgh-mobile-app) calls `spawn_agent`, the completion notification
currently always goes to `cca:notify:{server_namespace}` (money-brain). It should route to
`cca:notify:{spawning_namespace}` — whatever namespace the caller provides.

## Root cause
1. `spawn_agent` has no `spawning_namespace` parameter
2. `JobRecord` and `JobEvent` have no `spawningNamespace` field
3. `coordinator.ts::processEvent()` always uses `this.namespace` (server's own namespace)

## Approach
Add `spawning_namespace` as an optional parameter through the entire call chain:

1. **`src/types.ts`** — add `spawningNamespace?` to `JobEvent` and `SpawnOptions`; add to `Job`
2. **`src/store.ts`** — add `spawningNamespace?` to `JobRecord`
3. **`src/agent.ts`** — propagate through `spawn()`, `toRecord()`, `fromRecord()`, `publishJobEvent()`
4. **`src/coordinator.ts`** — parse `spawningNamespace` from stream entry; use it in `processEvent()`
5. **`src/index.ts`** — add `spawning_namespace` parameter to `spawn_agent` schema and handler

## Files to touch
- `src/types.ts`
- `src/store.ts`
- `src/agent.ts`
- `src/coordinator.ts`
- `src/index.ts`

## Risks
- Low risk: purely additive optional field; falls back to existing behavior when not set
- `parseStreamEntry` must handle missing field gracefully (it uses `obj.x ?? ""` pattern)
