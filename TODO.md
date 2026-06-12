# TODO — Fix MCP subprocess stealing meta-agent input queue messages

- [x] git checkout -b fix/poll-input-queues-launchd-guard
- [ ] Add guard to pollInputQueues() in src/meta-agent.ts
- [ ] Update meta-agent.test.ts: set env var in poller describe, add guard test
- [ ] npm install && npm test
- [ ] git add + diff review + commit + push + PR + merge
- [ ] npm version patch && git push --follow-tags && npm publish --access public
