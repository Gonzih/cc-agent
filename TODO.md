# TODO — Inject current date into preamble

- [x] Write PLAN.md and TODO.md
- [ ] git checkout -b fix/inject-current-date
- [ ] preamble.ts: create getPreamble(), update injectPreamble + getPreambleText, remove DEFAULT_PREAMBLE const
- [ ] agent.test.ts: replace DEFAULT_PREAMBLE with getPreamble(), add fake timers to affected describe blocks
- [ ] npm install && npm test (all pass)
- [ ] git add -A && git diff --staged (review)
- [ ] git commit
- [ ] git push -u origin fix/inject-current-date
- [ ] gh pr create + gh pr merge --squash --auto
- [ ] npm version patch && git push --follow-tags && npm publish --access public
