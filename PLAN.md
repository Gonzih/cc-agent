# Plan: Fix meta-agent gaps 5-7

## Task Restatement
Three meta-agent architecture gaps need fixing:
- **Gap 5**: Tool description for `message_meta_agent` is wrong (says LPUSH/poll; reality is direct spawn). Also need to drain stale `cca:meta:{ns}:input` keys on startup.
- **Gap 6**: Race condition — concurrent `messageMetaAgent()` calls can orphan the first process.
- **Gap 7**: `publishOutput()` missing log write to `cca:chat:log:{ns}`.

## Current State (after reading code)
- `inputKey()` helper — **already exists** (line 60)
- `logKey()` helper — **already exists** (line 64)
- `publishOutput()` LPUSH + LTRIM — **already implemented** (lines 385-386) — Gap 7 already done
- Concurrent guard — **missing** — Gap 6 needs fix
- Tool description — **wrong** — Gap 5 needs fix
- Stale key drain — **missing** from `startMetaAgent()` — Gap 5 needs fix

## Files to Touch
- `src/index.ts` — fix tool description line 681
- `src/meta-agent.ts` — add concurrent guard + stale key drain

## Approach
Minimal targeted edits. No refactoring beyond what is asked.
