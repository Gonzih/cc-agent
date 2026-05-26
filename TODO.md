# TODO — coder builtin profile

- [ ] Add `coder` profile to BUILTIN_PROFILES in src/seeds.ts
- [ ] Update seedBuiltinProfiles to overwrite when existing.builtin === true
- [ ] Update seeds.test.ts (count 7→8, add overwrite test, add coder test)
- [ ] npm install && npm test
- [ ] git checkout -b feat/coder-builtin-profile
- [ ] git add + commit + git diff --staged review
- [ ] git push + gh pr create + gh pr merge --squash --auto
- [ ] npm version patch && npm publish --access public
