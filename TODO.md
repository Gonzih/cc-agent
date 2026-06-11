# TODO — Fix spawning_namespace env-var injection (0.15.33)

- [ ] git checkout -b fix/spawning-namespace-inject-env
- [ ] Fix spawn_agent handler: `?? namespace` → `?? process.env.CC_AGENT_NAMESPACE ?? namespace`
- [ ] Fix spawn_from_profile handler: same
- [ ] Add test verifying CC_AGENT_NAMESPACE env var used at request time
- [ ] npm install && npm run build && npm test
- [ ] git add + diff review + commit + push + PR + merge
- [ ] npm version patch && git push --follow-tags && npm publish --access public
