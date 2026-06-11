# TODO — Fix meta-agent token injection (0.15.34)

- [ ] git checkout -b fix/meta-agent-token-fallback
- [ ] Add `MASTER_TOKEN_KEY` constant and `getMasterToken()` to `src/tokens.ts`
- [ ] Write master token to Redis at startup in `src/index.ts`
- [ ] Inject master token into spawn env in `src/meta-agent.ts`
- [ ] Add tests for `getMasterToken()` in `src/tokens.test.ts`
- [ ] npm install && npm test
- [ ] git add + diff review + commit + push + PR + merge
- [ ] npm version patch && git push --follow-tags && npm publish --access public
- [ ] redis-cli SET cca:token:master "..."
