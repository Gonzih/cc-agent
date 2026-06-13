# TODO — Strip meta-agent lifecycle

- [ ] git checkout -b feat/strip-meta-agent
- [ ] bump @gonzih/cc-wire from ^0.1.6 to ^0.3.0 in package.json
- [ ] delete src/meta-agent.ts
- [ ] delete src/meta-agent.test.ts
- [ ] update src/cron.ts — remove metaAgentManager import, simplify fire() to always use manager.spawn()
- [ ] update src/cron.test.ts — remove meta-agent mock, update repoUrl routing test
- [ ] update src/index.ts — remove MetaAgentManager import, instance, 4 tool defs, 4 case handlers, startPoller() call
- [ ] npm install && npm test
- [ ] git add + diff review + commit + push
- [ ] gh pr create + merge
- [ ] npm version minor && git push --follow-tags && npm publish --access public
