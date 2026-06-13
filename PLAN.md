# Plan: Strip meta-agent lifecycle — cc-agent becomes a pure job runner

## Task restated
cc-discord now owns meta-agent processes directly. cc-agent's job is solely `spawn_agent` —
running code tasks in temporary workspaces. This PR removes all meta-agent lifecycle code:
polling loops, process management, workspace cloning for persistent sessions, and the four
MCP tools that exposed this functionality. It also upgrades @gonzih/cc-wire from 0.1.6 to 0.3.0.

## Approaches considered

1. **Delete meta-agent.ts, update all consumers** — clean break, leaves cron routing changed.
2. **Keep meta-agent.ts but stub all methods** — less clean, dead code.
3. **Deprecation shim** — unnecessary, this is a breaking minor bump.

**Chosen: Approach 1.** Delete meta-agent.ts and meta-agent.test.ts entirely. Update cron.ts
to route crons with repoUrl through manager.spawn() instead. Remove all MCP tool definitions
and handlers. Clean, no dead code.

## Files to touch
- `src/meta-agent.ts` — DELETE
- `src/meta-agent.test.ts` — DELETE
- `src/index.ts` — remove MetaAgentManager import, instance, 4 tool defs, 4 case handlers, startPoller() call
- `src/cron.ts` — remove metaAgentManager import/usage; route repoUrl crons via manager.spawn()
- `src/cron.test.ts` — update cron-with-repoUrl test to check manager.spawn, remove meta-agent mock
- `package.json` — bump @gonzih/cc-wire ^0.1.6 → ^0.3.0

## Risks
- cron.test.ts test "fires cron with repoUrl via metaAgentManager.messageMetaAgent" must be updated
- chatIncomingChannel/chatOutgoingChannel still used in get_pubsub_status — keep those imports
- CC_AGENT_VERSION_KEY still used in index.ts — keep that import
- After removing the meta-agent routing from cron.ts, crons with repoUrl go to spawn_agent;
  the cron.test.ts mock for meta-agent.js must be removed
