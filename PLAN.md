# Plan: Wire chat_id through spawn_agent → coordinator notifications

## Task restated
The `spawn_agent` MCP tool accepts `chat_id` but never passes it to `manager.spawn()`.
Completion notifications therefore have no Discord channel to route back to.
Wire the field through all layers so notifications include `chat_id` when set.

## Approach
Single linear pass through the type/data pipeline:
types.ts → store.ts → agent.ts (spawn + publishJobEvent) → index.ts → coordinator.ts

## Files to touch
- `src/types.ts` — add chatId to Job, SpawnOptions, JobEvent
- `src/store.ts` — add chatId to JobRecord
- `src/agent.ts` — spawn() assigns chatId; toRecord/fromRecord; publishJobEvent xadd
- `src/index.ts` — spawn_agent case passes chatId; add chat_id to inputSchema
- `src/coordinator.ts` — parseStreamEntry parses chatId; processEvent uses it in notify
