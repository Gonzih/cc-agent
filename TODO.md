# TODO — Issue #134: auto-inject spawning_namespace

- [ ] git checkout -b fix/auto-inject-spawning-namespace
- [ ] Fix spawn_agent handler: auto-inject namespace as spawningNamespace fallback
- [ ] Fix spawn_from_profile handler: add spawningNamespace + schema field
- [ ] Fix create_plan handler: add spawningNamespace to all manager.spawn() calls
- [ ] Add test verifying auto-injection when spawning_namespace not provided
- [ ] npm run build && npm test
- [ ] git add + diff review + commit + push + PR + merge
- [ ] npm version patch && git push --follow-tags && npm publish --access public
