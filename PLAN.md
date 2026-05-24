# Plan: Redis Protocol Compliance Audit

## Task Restatement
Audit cc-agent against the cc-suite Redis protocol spec and fix all deviations:
notifications must be JSON objects, coordinator must use XREADGROUP, timestamps must be
ISO strings, ChatMessage shapes must match protocol, chat log writes must also publish to
outgoing channel, timing constants must be named, and the protocol doc must live in the repo.

## Deviations Found

### 1. NotificationPayload (coordinator.ts:notify)
- CURRENT: publishes plain string `"✅ title (job_id: X)\nrepoUrl"`
- PROTOCOL: must be JSON `{ text: "..." }`
- FIX: Wrap message in JSON before publishing to cca:notify:{ns} and cca:notify-log:{ns}

### 2. Coordinator XREAD → XREADGROUP
- CURRENT: raw `redis.xread(...)` with cursor in `cca:coordinator:last-id:{ns}`
- PROTOCOL: must use XREADGROUP with group "coordinator" and MKSTREAM
- FIX: On start() create group (BUSYGROUP-safe), replayMissedEvents uses '0', poll uses '>'

### 3. JobEvent.timestamp as Unix number
- CURRENT: `timestamp: number` (Date.now())
- PROTOCOL: all dates must be ISO strings
- FIX: `timestamp: string`, use `new Date().toISOString()` everywhere

### 4. ChatMessage shape in meta-agent.ts
- CURRENT: `{ id, role, source, namespace, content, timestamp }` with source "coordinator"
- PROTOCOL: `{ id, source, role, content, timestamp, chatId }` with source in 'telegram|ui|claude|cc-tg'
- FIX: Replace `namespace` with `chatId: 0`; change source "coordinator" → "cc-tg"

### 5. Chat log missing outgoing publish (meta-agent.ts pollInputQueues)
- CURRENT: coordinator entries LPUSH to chat:log but do NOT publish to chat:outgoing
- PROTOCOL: every LPUSH to chat:log must also PUBLISH to chat:outgoing
- FIX: Add `redis.publish(outChannel, coordinatorEntry)` in pollInputQueues

### 6. Chat log LIFO ordering comment
- CURRENT: no comment noting LIFO / newest-first ordering
- FIX: Add comment at LPUSH sites

### 7. Named timing constants
- CURRENT: dependency tick `setInterval(() => this.tick(), 3000)` is magic number
- FIX: Add `const DEPENDENCY_TICK_MS = 3000` in agent.ts

### 8. Protocol doc missing
- FIX: Create docs/redis-protocol.md with source note (fetch 404'd — private repo)

## Already Compliant
- JOB_TTL_SECONDS = 7 days ✅
- PLAN_TTL_SECONDS = 30 days ✅
- LEARNINGS_TTL_SECONDS = 90 days ✅
- COORDINATOR_POLL_MS = POLL_INTERVAL_MS = 2000 ✅ (already named)
- INPUT_POLL_INTERVAL_MS = 3000 in meta-agent.ts ✅

## Files to Touch
- src/coordinator.ts — notify JSON, XREADGROUP, MKSTREAM, timestamp
- src/types.ts — JobEvent.timestamp: string
- src/agent.ts — ISO timestamp in publishJobEvent, DEPENDENCY_TICK_MS constant
- src/meta-agent.ts — ChatMessage shape, source, outgoing publish, LIFO comment
- src/coordinator.test.ts — update mocks and assertions for JSON + XREADGROUP
- docs/redis-protocol.md — new file with protocol source note

## Risks
- coordinator.test.ts currently asserts plain string notification format — must update
- Changing xread→xreadgroup requires updating mock object in coordinator.test.ts
- The protocol doc URL (gonzih/money-brain) returns 404 — create stub from task spec
- Consumers of cca:notify-log (list_notifications MCP tool) will now receive JSON strings
