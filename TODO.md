# TODO — write error-handling and edge-case tests

- [x] Write PLAN.md and TODO.md
- [x] git checkout -b feat/error-path-tests
- [x] Extend src/swarm.test.ts (parseDecomposeResponse errors + buildSynthesisTask bounds)
- [x] Extend src/tokens.test.ts (null Redis, zero tokens, comma-only CLAUDE_TOKENS)
- [x] Extend src/namespace.test.ts (CWD="/", empty CC_AGENT_NAMESPACE)
- [x] Create src/store-errors.test.ts (Redis failure → in-memory fallback)
- [x] npm install && npm test — 369 passing, 12 pre-existing failures
- [x] git diff --staged, commit, push, PR
