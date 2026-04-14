# Plan: Auto-start meta-agent on message if not running

## Task Restatement
In `messageMetaAgent`, before enqueuing the message, check if a meta-agent process is
already running for the given namespace. If not, call `startMetaAgent(namespace)` first,
then proceed with enqueuing as normal.

## Approach
Single approach: add an in-method guard at the top of `messageMetaAgent` in
`src/meta-agent.ts`. Check `this.processes.get(namespace)` — if missing or killed, call
`await this.startMetaAgent(namespace)` before the lpush. No new config, no flags.

## Files to Touch
- `src/meta-agent.ts` — add guard in `messageMetaAgent`
- `src/meta-agent.test.ts` — add test for auto-start behavior

## Risks
- `startMetaAgent` relies on Redis for `saveState` — but Redis check comes first in
  `messageMetaAgent`, so if Redis is unavailable we throw before attempting auto-start.
- No repoUrl available in `messageMetaAgent` — pass `undefined`, which means
  `startMetaAgent` uses default gonzih URL. If workspace already cloned, no issue.
