# Plan: Verbose Logging — [cron] / [job] / [spawn] / [mcp]

## Task Restatement
Add structured, grep-friendly logging throughout cc-agent. Each log line gets a
`[cron]`, `[job]`, `[spawn]`, or `[mcp]` prefix so operators can filter by subsystem.
Covers: cron fire/registered, job lifecycle, agent subprocess pid/exit, MCP tool calls,
and a startup banner with job/cron counts.

## Approaches

### A. New log wrapper functions per subsystem
Add `logCron()`, `logJob()`, `logSpawn()`, `logMcp()` helpers that inject the prefix
automatically. Clean, but requires touching every call site and adding a new abstraction.

### B. Rename message strings in place (chosen)
Change existing `logger.info("cron:start", ...)` → `logger.info("[cron] start", ...)`.
Add new calls where missing. Zero new abstractions, consistent with the existing pattern
of plain `logger.info(msg, data)` calls. Tests mock logger entirely so message renames
are safe.

### C. Structured log levels (DEBUG/INFO/WARN)
Add a DEBUG level to logger.ts for tool calls. Rejected: unnecessary complexity; the
existing INFO level is sufficient for operators tailing the log file.

## Decision: Approach B

## Files to Touch
- `src/cron.ts` — rename `cron:xxx` → `[cron] xxx`, add `[cron] fired` at top of fire()
- `src/agent.ts` — rename `job:xxx` → `[job] xxx`, add `[spawn]` logs, enhance data fields
- `src/index.ts` — rename `tool:xxx` → `[mcp] xxx`, add startup summary after cronEngine.start()

## What Changes

### cron.ts
- Prefix all existing `cron:xxx` messages to `[cron] xxx`
- Add `[cron] fired` at start of `fire()` with id, schedule, intervalMs, prompt[:200]

### agent.ts
- Prefix all existing `job:xxx` messages to `[job] xxx`
- `[job] created` — add task[:200] and branch to existing job:spawned
- `[job] cloning` — add branch field
- `[job] running` — add pid field
- `[job] done` — add duration_seconds and output_lines
- `[job] failed` — add exit_code
- Add `[spawn] subprocess started` after driver.spawn() — pid, cwd, driver (no token)
- Add `[spawn] subprocess exited` in exit handler — exit_code

### index.ts
- Prefix all existing `tool:xxx` messages to `[mcp] xxx`
- Add startup summary after cronEngine.start():
  - `[cc-agent] started` with version + namespace
  - `[cc-agent] startup` with total jobs and per-status counts
  - `[cc-agent] startup` with cron count
  - `[cron] registered` for each loaded cron

## Risks
- Log message renames: tests mock logger entirely — safe
- duration_seconds computed at job:done before finishedAt is set — use Date.now()
