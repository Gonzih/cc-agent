# Plan: Log coordinator inputs to chat log

## Task Restatement
When `message_meta_agent` MCP pushes a message to `cca:meta:{namespace}:input`,
`pollInputQueues` dequeues it and passes it to Claude via `messageMetaAgent`.
But the incoming message is never written to `cca:chat:log:{namespace}`.
Result: the chat log only has assistant (`role: "assistant"`) responses —
the user-side messages are invisible to the UI.

## Fix
In `pollInputQueues`, immediately after extracting `content` from the dequeued
raw value, write a log entry to `cca:chat:log:{namespace}` via lpush+ltrim
with shape:
```json
{ "id": "<uuid>", "role": "user", "source": "coordinator", "namespace": "...",
  "content": "...", "timestamp": "<ISO>" }
```
This matches the structure of assistant entries (same key, same ltrim cap of 499).

## Files to Touch
- `src/meta-agent.ts` — add lpush/ltrim call in pollInputQueues
- `src/meta-agent.test.ts` — add test verifying coordinator input is logged
