# TODO — log coordinator inputs to chat log

- [x] Write PLAN.md and TODO.md
- [ ] Create feature branch fix/log-coordinator-inputs
- [ ] Edit pollInputQueues in src/meta-agent.ts to lpush coordinator input to chat log
- [ ] Add test in src/meta-agent.test.ts verifying coordinator input is logged
- [ ] npm install && npm test — fix any failures
- [ ] Commit and push
- [ ] gh pr create + gh pr merge --squash --auto
- [ ] npm version patch && npm publish --access public
- [ ] redis-cli notify
