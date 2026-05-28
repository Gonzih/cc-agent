# TODO — dynamic workflows

- [x] Write PLAN.md and TODO.md
- [ ] Add WorkflowStatus, WorkflowStep, WorkflowStage, WorkflowRecord types to src/types.ts
- [ ] Create src/workflow.ts (decomposition engine + Redis helpers + public API)
- [ ] Add generate_workflow + get_workflow_status tools to src/index.ts (import + tool defs + case handlers)
- [ ] Create src/workflow.test.ts (unit tests for parseWorkflowResponse + validation)
- [ ] Update README.md tools table
- [ ] npm install && npm run build && npm test
- [ ] git checkout -b feat/dynamic-workflows
- [ ] git add + diff review + commit
- [ ] git push + gh pr create + gh pr merge --squash --auto
- [ ] npm version patch && git push --follow-tags && npm publish --access public
