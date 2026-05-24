# TODO — migrate cc-agent to @gonzih/cc-wire

- [x] Write PLAN.md and TODO.md
- [x] git checkout -b feat/cc-wire-migration
- [x] Clone cc-wire, add deletedCronsKey + JOB_INDEX_GLOB + JOB_INDEX_PREFIX
- [x] Bump cc-wire to 0.1.1, push, publish
- [x] Add @gonzih/cc-wire to cc-agent package.json and npm install
- [x] Migrate src/tokens.ts
- [x] Migrate src/namespace.ts
- [x] Migrate src/coordinator.ts
- [x] Migrate src/meta-agent.ts
- [x] Migrate src/cron.ts
- [x] Migrate src/store.ts
- [x] Migrate src/agent.ts
- [x] Migrate src/swarm.ts
- [x] Migrate src/index.ts
- [x] npm test — 312 pass, 12 pre-existing redis.del mock failures
- [ ] git diff --staged, commit, push, npm version patch, npm publish
- [ ] gh pr create + gh pr merge --squash --auto
