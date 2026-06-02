# Plan: effort_level and fast_mode params

## Task restated
Add optional `effort_level` (low|medium|high|xhigh|max|auto) and `fast_mode` (bool) to
`spawn_agent`, `create_plan` step objects, and profile schema. When set, prepend `/effort <level>\n`
and/or `/fast\n` to the task prompt so Claude Code sees them at session start. Store both on job
records so `list_jobs`/`get_job_status` can surface them.

## Approach
Single pass: thread both new fields through the type chain from MCP schema → SpawnOptions →
Job/JobRecord → prompt injection in `spawn()`. No new files needed.

## Files to touch
- `src/types.ts` — add `effortLevel?` and `fastMode?` to `SpawnOptions` interface
- `src/store.ts` — add `effortLevel?` and `fastMode?` to `JobRecord` and `Profile` interfaces
- `src/agent.ts` — prepend `/effort` and `/fast` in `spawn()` before learnings injection
- `src/index.ts` — update MCP schemas for spawn_agent, create_plan step, create_profile,
  spawn_from_profile; update mapping block; pass through in plan handler
- `README.md` — document new params
- `src/agent.test.ts` (or new test file) — tests for prompt injection logic

## Risks
- Task prompt modification order: effort/fast must be prepended BEFORE preamble injection so the
  commands land at the very start of the session; check injectPreamble order
- Profile defaults vs per-call overrides: spawn_from_profile should merge profile defaults with
  call-time overrides (call-time wins)
