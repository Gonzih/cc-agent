# TODO — meta-agent WRONGTYPE + orphan-process fixes

- [x] Read PLAN.md and TODO.md
- [x] Read src/meta-agent.ts and src/meta-agent.test.ts
- [ ] Create feature branch fix/meta-agent-redis-and-orphan
- [ ] Bug 1: replace hset with read-modify-write in messageMetaAgent
- [ ] Bug 2: add orphan-kill logic in startMetaAgent
- [ ] Update test "updates lastMessageAt in Redis" → verify no hset called
- [ ] Add test: orphan process killed when prior PID alive
- [ ] Add test: no kill when prior state has no PID
- [ ] Run npm install && npm test
- [ ] Commit and push
- [ ] gh pr create + gh pr merge --squash --auto
- [ ] npm version patch && npm publish --access public
