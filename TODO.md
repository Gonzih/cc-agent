# TODO — Wire chat_id through spawn_agent → coordinator notifications

- [x] Read existing code and plan
- [ ] git checkout -b feat/chat-id-routing
- [ ] src/types.ts — add chatId to Job, SpawnOptions, JobEvent
- [ ] src/store.ts — add chatId to JobRecord
- [ ] src/agent.ts — spawn() assigns chatId; toRecord/fromRecord; publishJobEvent xadd + JobEvent
- [ ] src/index.ts — pass chatId in spawn_agent case; add chat_id to inputSchema
- [ ] src/coordinator.ts — parseStreamEntry + processEvent
- [ ] npm install && npm test
- [ ] git add + diff review + commit
- [ ] gh pr create + merge + publish
