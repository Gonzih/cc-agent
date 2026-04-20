# TODO — multi-agent driver abstraction

- [x] Write PLAN.md and TODO.md
- [ ] Create feature branch feat/multi-agent-driver
- [ ] Create src/drivers/types.ts
- [ ] Create src/drivers/pricing.ts
- [ ] Create src/drivers/claude-code.ts
- [ ] Create src/drivers/aider.ts
- [ ] Create src/drivers/openai-compatible.ts
- [ ] Create src/drivers/index.ts
- [ ] Extend src/types.ts with agentDriver/agentModel
- [ ] Extend src/store.ts with agentDriver/agentModel in JobRecord
- [ ] Refactor src/agent.ts to use driver
- [ ] Extend src/index.ts with new MCP params + list_drivers
- [ ] Write driver tests
- [ ] npm install && npm test
- [ ] Commit + push
- [ ] gh pr create + gh pr merge --squash --auto
- [ ] npm version minor && npm publish --access public
