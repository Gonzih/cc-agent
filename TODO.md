# TODO — swarm_task + get_swarm_status

- [x] Write PLAN.md and TODO.md
- [ ] git checkout -b feat/swarm-task
- [ ] Implement src/swarm.ts (SwarmRecord, decomposeGoal, buildSynthesisTask, runSwarm, getSwarmStatus)
- [ ] Write src/swarm.test.ts (3+ unit tests)
- [ ] Add swarm_task + get_swarm_status tools to src/index.ts (ListTools + CallTool)
- [ ] npm install && npm run build
- [ ] npm test (all pass)
- [ ] git add specific files && git diff --staged (review carefully)
- [ ] git commit -m "feat: swarm_task — auto-decompose + parallel fan-out + synthesis"
- [ ] git push -u origin feat/swarm-task
- [ ] gh pr create + gh pr merge --squash --auto
- [ ] npm version patch && git push --follow-tags && npm publish --access public
