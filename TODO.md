# TODO — inject cc-agent MCP into every agent workspace

- [x] Write PLAN.md and TODO.md
- [x] git checkout -b feat/inject-cc-agent-mcp
- [ ] Create src/mcp-inject.ts (injectMcpConfig helper)
- [ ] Create src/mcp-inject.test.ts (unit tests)
- [ ] Modify src/agent.ts: call injectMcpConfig before driver.spawn()
- [ ] Modify src/meta-agent.ts: call injectMcpConfig before spawn()
- [ ] npm install && npm run build
- [ ] npm test (all pass)
- [ ] git add specific files && git diff --staged (review carefully)
- [ ] git commit + git push -u origin feat/inject-cc-agent-mcp
- [ ] gh pr create + gh pr merge --squash --auto
- [ ] npm version patch && git push --follow-tags && npm publish --access public
