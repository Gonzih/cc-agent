# Plan: Per-Repo Meta-Agent Sessions

## Task Restatement
Add persistent, long-lived Claude Code sessions (meta-agents) to cc-agent, one per repo namespace.
Exposed as 4 new MCP tools: start_meta_agent, message_meta_agent, list_meta_agents, stop_meta_agent.

## Approaches Considered

### A) In-process spawning with Redis I/O (chosen)
Spawn `claude --continue` as a child process in `~/cc-agent-workspace/{namespace}`. Poll
`cca:meta:{namespace}:input` every 3s → write to stdin. Read stdout line-by-line → publish to
`cca:chat:outgoing:{namespace}` via redis.publish.
**Pros:** Mirrors existing job input poller pattern exactly, leverages existing Redis infra, no new deps.
**Cons:** Process lifetime tied to cc-agent process.

### B) systemd/launchd-managed processes
**Cons:** Requires OS-level setup, not portable.

### C) tmux/screen sessions
**Cons:** Requires tmux installed, harder to capture output programmatically.

## Chosen: Approach A

## Files to Touch
- `src/meta-agent.ts` — NEW: MetaAgentManager class
- `src/index.ts` — Add 4 tool definitions + handler cases, import MetaAgentManager

## Implementation Details
- `MetaAgentManager` maintains `Map<string, ChildProcess>` for live processes
- Redis state: `cca:meta:{namespace}` → JSON with { namespace, repoUrl, cwd, pid, status, startedAt, lastMessageAt }
- Index: `cca:meta:agents:index` Redis set (similar to `cca:jobs:index`) — avoids fragile key scanning
- Input: `cca:meta:{namespace}:input` list (LPUSH enqueue, RPOP consume), polled every 3s
- Output: each stdout line published to Redis channel `cca:chat:outgoing:{namespace}`
- `ensureWorkspace`: `~/cc-agent-workspace/{namespace}`, clone via `gh repo clone` if missing
- `startMetaAgent`: spawn `claude --continue`, set up pollers, update Redis
- `messageMetaAgent`: LPUSH to input queue, update lastMessageAt
- `listMetaAgents`: smembers on index set, fetch each JSON state
- `stopMetaAgent`: kill process, update Redis status to stopped

## Risks
- `claude --continue` may behave differently with stdin injection than fresh sessions
- Need to handle process already running (idempotent start)
