# TODO — Fix Job Completion Notification Routing

- [ ] git checkout -b fix/job-completion-routing
- [ ] Add spawningNamespace to JobEvent and SpawnOptions in src/types.ts
- [ ] Add spawningNamespace to Job in src/types.ts
- [ ] Add spawningNamespace to JobRecord in src/store.ts
- [ ] Propagate spawningNamespace through spawn(), toRecord(), fromRecord(), publishJobEvent() in src/agent.ts
- [ ] Parse and use spawningNamespace in coordinator.ts
- [ ] Add spawning_namespace param to spawn_agent schema and handler in src/index.ts
- [ ] npm install && npm run build && npm test
- [ ] git add + diff review + commit + push + PR + merge
- [ ] npm version patch && git push --follow-tags && npm publish --access public
