# TODO — Verbose Logging

- [x] Write PLAN.md and TODO.md
- [x] git checkout -b feat/verbose-logging
- [ ] cron.ts: rename cron:xxx → [cron] xxx, add [cron] fired at start of fire()
- [ ] agent.ts: rename job:xxx → [job] xxx, add [spawn] logs, enhance data fields
- [ ] index.ts: rename tool:xxx → [mcp] xxx, add startup summary
- [ ] npm install && npm test (verify all tests pass)
- [ ] git add -A && git diff --staged (review diff)
- [ ] git commit
- [ ] git push -u origin feat/verbose-logging
- [ ] gh pr create + gh pr merge --squash --auto
- [ ] npm version patch && git push --follow-tags && npm publish --access public
