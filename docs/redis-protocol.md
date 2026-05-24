# cc-suite Redis Protocol

> Source of truth: gonzih/money-brain research/cc-suite-redis-protocol.md — sync manually on breaking changes
>
> Note: The upstream document lives in a private repository. This copy documents the protocol as implemented in cc-agent. Update both files on breaking changes.

---

## Key Conventions

- **All date/time values are ISO 8601 strings** — never Unix timestamps.
- **All Redis Stream field values are strings** (XADD requirement — numbers must be stringified).
- **Consumer groups** must be used for stream reads — raw XREAD is not permitted.

---

## Key Schema: `cca:event-stream` (Redis Stream)

Written by cc-agent via `XADD cca:event-stream *` when a job changes status.

**Fields (all strings):**

| Field            | Type   | Description                              |
|------------------|--------|------------------------------------------|
| jobId            | string | UUID of the job                          |
| status           | string | done / failed / running / etc.           |
| title            | string | First line of task, truncated to 120 ch  |
| repoUrl          | string | Repository URL                           |
| lastLines        | string | JSON-encoded array of last 5 output lines|
| score            | string | Float 0.0–1.0 as string, or empty string |
| timestamp        | string | ISO 8601 timestamp                       |
| coordinatorPlan  | string | JSON-encoded CoordinatorPlan or "null"   |

**Consumer group:** `coordinator` — created with `XGROUP CREATE cca:event-stream coordinator 0 MKSTREAM`.
Use `XREADGROUP GROUP coordinator <consumer> COUNT 100 STREAMS cca:event-stream >` for polling, `0` for replaying unACKed messages after restart. XACK each processed entry.

---

## Key Schema: `cca:notify:{namespace}` (Redis Pub/Sub)

Published by the coordinator when a job completes or fails.

**Channel:** `cca:notify:{namespace}`  
**Log list:** `cca:notify-log:{namespace}` (LPUSH, capped at 100, LIFO — newest first)

**Payload shape (JSON string):**
```json
{ "text": "✅ Job title (score: 0.85) (job_id: abc123)\nhttps://github.com/...", "driver": "claude", "model": "claude-sonnet-4-5", "cost": 0.42 }
```

Required fields: `text`. Optional: `driver`, `model`, `cost`.

---

## Key Schema: `cca:job:{id}` (Redis String)

**TTL:** 7 days (`EX 604800`)

**Shape (JobRecord, JSON):**

| Field             | Type               | Description                     |
|-------------------|--------------------|---------------------------------|
| id                | string             | UUID                            |
| status            | JobStatus          | pending / running / done / etc. |
| repoUrl           | string             | Repository URL                  |
| task              | string             | Full task description           |
| startedAt         | string (ISO 8601)  | When job was created            |
| finishedAt        | string (ISO 8601)? | When job completed              |
| score             | number?            | Quality score 0.0–1.0           |
| costUsd           | number?            | Estimated USD cost              |

---

## Key Schema: `cca:plan:{id}` (Redis String)

**TTL:** 30 days (`EX 2592000`)

---

## Key Schema: `cca:learnings:{namespace}` (Redis List)

**TTL:** 90 days (`EX 7776000`)  
**Ordering:** LIFO — newest entry at index 0 (LPUSH). Consumers read index 0 for the latest compressed block.

---

## Key Schema: `cca:chat:log:{namespace}` (Redis List)

**Ordering:** LIFO — newest first (LPUSH). **Consumers must reverse for chronological display.**

Every message written to `cca:chat:log:{namespace}` via LPUSH **must also** be published to `cca:chat:outgoing:{namespace}` via PUBLISH.

**ChatMessage shape (JSON string):**

```json
{ "id": "uuid", "source": "claude", "role": "assistant", "content": "...", "timestamp": "2026-01-01T00:00:00.000Z", "chatId": 0 }
```

| Field     | Type                                     | Description                      |
|-----------|------------------------------------------|----------------------------------|
| id        | string (UUID)                            | Unique message ID                |
| source    | `'telegram'|'ui'|'claude'|'cc-tg'`       | Origin of the message            |
| role      | `'user'|'assistant'`                     | Speaker role                     |
| content   | string                                   | Message text                     |
| timestamp | string (ISO 8601)                        | When message was created         |
| chatId    | number                                   | Telegram chat ID (0 for non-tg)  |

---

## Key Schema: `cca:meta-agent:status:{namespace}` (Redis String)

**TTL:** 7 days  
**Shape:** MetaAgentStatus JSON — written by meta-agent on every status change.

---

## Timing Constants

| Constant              | Value  | Location         |
|-----------------------|--------|------------------|
| COORDINATOR_POLL_MS   | 2000ms | coordinator.ts   |
| DEPENDENCY_TICK_MS    | 3000ms | agent.ts         |
| INPUT_POLL_INTERVAL_MS| 3000ms | meta-agent.ts    |

---

## TTL Summary

| Key pattern                    | TTL      |
|--------------------------------|----------|
| `cca:job:{id}`                 | 7 days   |
| `cca:job:{id}:output`          | 7 days   |
| `cca:job:done:{id}:queue`      | 7 days   |
| `cca:plan:{id}`                | 30 days  |
| `cca:learnings:{ns}`           | 90 days  |
| `cca:meta:{ns}`                | 30 days  |
| `cca:meta-agent:status:{ns}`   | 7 days   |
