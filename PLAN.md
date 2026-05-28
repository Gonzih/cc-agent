# Plan: Dynamic Workflows — generate_workflow + get_workflow_status

## Task Restatement
Add two new MCP tools to cc-agent:
- `generate_workflow`: Takes a natural language goal, decomposes it into an ordered stage DAG via Claude Haiku, spawns all jobs with stage-based `dependsOn` constraints, persists a WorkflowRecord to Redis.
- `get_workflow_status`: Reads WorkflowRecord from Redis, enriches with live job statuses, returns per-stage breakdown.

## Approach
Mirror `swarm.ts` pattern exactly — same Haiku API call, same Redis helpers, same in-memory fallback, same fire-and-return (no background loop needed for workflows since stage ordering is enforced via `dependsOn`).

The key difference from swarm: instead of flat parallel tasks, we produce an ordered list of stages. Each step in stage N is spawned with `dependsOn` pointing to all job IDs from stage N-1. This guarantees stage ordering via the existing job dependency infrastructure.

## Files to Touch
1. `src/types.ts` — add `WorkflowStatus`, `WorkflowStep`, `WorkflowStage`, `WorkflowRecord` types
2. `src/workflow.ts` — NEW: decomposition engine + Redis helpers + public API
3. `src/index.ts` — add import + two tool definitions + two case handlers
4. `src/workflow.test.ts` — NEW: unit tests for `parseWorkflowResponse` + stage validation
5. `README.md` — add two tools to MCP tools table

## Risks / Unknowns
- `workflowKey` does not exist in `@gonzih/cc-wire` — define inline as `cca:workflow:<id>`
- `node_modules` not installed yet — must `npm install` before build/test
- `WorkflowStep.job_id` is mutated during spawn loop — must be optional in the type
