# Plan: Fix spawning_namespace env-var injection (0.15.33)

## Task restated
Previous fix (0.15.32) added `?? namespace` fallback in spawn handlers, where `namespace`
is a module-level constant set once at startup. The root issue: if CC_AGENT_NAMESPACE is
set in `.mcp.json` env but the server process shares state from a stale startup, the cached
value may lag. The fix: read `process.env.CC_AGENT_NAMESPACE` at request time as primary
fallback, before the cached `namespace` constant.

## Approach
Minimal 2-line change in spawn handlers:
1. `spawn_agent` handler: `?? namespace` → `?? process.env.CC_AGENT_NAMESPACE ?? namespace`
2. `spawn_from_profile` handler: same change

## Files to touch
- `src/index.ts` — two one-line changes
- `src/index.test.ts` — add test verifying env var used at request time

## Risks
- Purely additive: explicit `spawning_namespace` arg still wins; `namespace` is ultimate fallback
- If CC_AGENT_NAMESPACE unset at request time, behavior identical to before
