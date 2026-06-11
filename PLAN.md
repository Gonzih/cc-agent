# Plan: Auto-inject spawning_namespace for meta-agent-spawned jobs (Issue #134)

## Task restated
When a meta-agent calls `spawn_agent` or `spawn_from_profile` without explicitly passing
`spawning_namespace`, the coordinator falls back to its own namespace (e.g. "money-brain"),
routing notifications to the wrong channel. Fix: auto-inject the current MCP server's
namespace as `spawningNamespace` when the caller doesn't provide one.

## Mechanism
- `injectMcpConfig(cwd, namespace)` sets `CC_AGENT_NAMESPACE` env var in the spawned MCP server
- `getNamespace()` reads this env var → local `namespace` variable at index.ts:92
- When running inside a meta-agent workspace: `namespace` = meta-agent's namespace
- When running as main coordinator: `namespace` = coordinator's namespace
- Either way, auto-fallback to `namespace` is always correct

## Approach
Minimal change: use `?? namespace` as fallback in three places:
1. `spawn_agent` handler: `spawningNamespace: (a.spawning_namespace as string | undefined) ?? namespace`
2. `spawn_from_profile` handler: add `spawningNamespace` to spawn call + add field to input schema
3. `create_plan` handler: add `spawningNamespace: namespace` to all `manager.spawn()` calls

## Files to touch
- `src/index.ts` — three handler sites + spawn_from_profile input schema

## Risks
- create_plan doesn't accept spawning_namespace from args — wiring it through the step schema
  would be a larger change; auto-injecting `namespace` is correct and sufficient
- The auto-inject is a fallback (??), so explicit override still works
