# TODO — meta-agent per-message claude -p fix

- [x] Write PLAN.md and TODO.md
- [ ] Create feature branch fix/meta-agent-per-message-spawn
- [ ] Rewrite src/meta-agent.ts: remove processes/pollers, add per-message spawn in messageMetaAgent
- [ ] Rewrite src/meta-agent.test.ts: add readdirSync mock, update/replace tests for new behavior
- [ ] Update src/index.ts: change "Message queued" to "Message delivered" in message_meta_agent handler
- [ ] Run npm install && npm test — fix any failures
- [ ] Commit and push
- [ ] gh pr create + gh pr merge --squash --auto
- [ ] npm version patch && npm publish --access public
