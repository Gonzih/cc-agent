# TODO — wiki layer

- [x] Write PLAN.md and TODO.md
- [ ] Create src/wiki.ts (WikiStore class + wikiStore singleton)
- [ ] Update src/store.ts (import and re-export wikiStore)
- [ ] Update src/agent.ts (inject wiki pages into task in spawn())
- [ ] Update src/index.ts (import wikiStore, add 5 tool defs + case handlers)
- [ ] Create src/wiki.test.ts (unit tests)
- [ ] Update README.md tools table
- [ ] npm install && npm run build && npm test
- [ ] git checkout -b feat/wiki-layer
- [ ] git add + diff review + commit
- [ ] git push + gh pr create + gh pr merge --squash --auto
- [ ] npm version patch && git push --follow-tags && npm publish --access public
