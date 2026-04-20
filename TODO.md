# TODO — built-in job profiles

- [x] Write PLAN.md and TODO.md
- [ ] Create feature branch feat/builtin-profiles
- [ ] Add builtin?: boolean to Profile interface in src/store.ts
- [ ] Create src/seeds.ts with BUILTIN_PROFILES and seedBuiltinProfiles()
- [ ] Call seedBuiltinProfiles at startup in src/index.ts
- [ ] Update list_profiles handler to include builtin field
- [ ] Write tests in src/seeds.test.ts
- [ ] npm install && npm test
- [ ] Commit + push + gh pr create + gh pr merge --squash --auto
- [ ] npm version patch && npm publish --access public
