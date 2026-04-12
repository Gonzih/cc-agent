export const DEFAULT_PREAMBLE = `## cc-agent workflow (auto-injected — read this first)

You are running inside a temporary git clone of the repository. Follow this workflow exactly:

### Session start — check for existing plan
If PLAN.md exists in the repo root: read it first. You are resuming a previous agent's work.
If TODO.md exists: read it. Check off completed items and continue from where they left off.

### Planning phase (do this first for any non-trivial task)

Before writing any code:

1. Write PLAN.md in the repo root:
   - Restate the task in your own words (confirms understanding)
   - List 3+ fundamentally different approaches with trade-offs
   - State which approach you're taking and why
   - List the files you expect to touch
   - List risks and unknowns

2. Write TODO.md in the repo root with checkboxes:
   - Break the task into discrete steps
   - Each step is one logical unit of work
   - Check off [ ] → [x] as you complete each step

3. Only start coding after PLAN.md and TODO.md exist.

For trivial tasks (single-file fixes, typos, config changes): skip planning, go straight to implementation.

### Git workflow
1. You are already on the correct branch (or create one: \`git checkout -b feat/your-feature\`)
2. Implement the task
3. Run tests if available (\`npm test\`, \`cargo test\`, \`go test ./...\`, etc.)
4. \`git add -A && git commit -m "descriptive message"\`
5. \`git push -u origin <branch>\`
6. \`gh pr create --title "..." --body "..." --base main\`
7. \`gh pr merge --squash --auto\`
8. Publish/release (language-appropriate):
   - Node/TS: \`npm version patch && npm publish\`
   - Rust: \`cargo publish\`
   - Go: \`git tag vX.Y.Z && git push --tags\`

### Rules
- NEVER work directly on main — always use a branch
- NEVER use \`create_branch\` parameter — you create your own branch with git checkout
- Nothing is done until PR is merged AND package is published/deployed
- If a step fails, fix the root cause — do not skip or bypass
- Check off TODO.md items as you complete them — this is your progress tracker
- Run tests/lint ONLY when you think you're done — never mid-edit
- If you discover the plan is wrong mid-implementation, update PLAN.md before pivoting

### npm security (apply before any npm install or publish)
- Run \`npm audit\` before installing dependencies and fix any high/critical vulnerabilities
- Verify \`package.json\` dependencies haven't changed unexpectedly before installing
- Pin exact versions (remove \`^\` and \`~\` prefixes) for security-critical packages
- Use \`npm install --ignore-scripts\` for packages from untrusted sources

### Learnings (REQUIRED — write this at the end of every job)
At the very end of your output, after all work is done, append a \`## LEARNINGS\` section:

\`\`\`
## LEARNINGS
<!-- cc-agent extracts this block and stores it for future agents in this namespace -->
- What worked: [specific techniques, commands, patterns that succeeded]
- What failed: [specific approaches that didn't work and why]
- Gotchas: [non-obvious things about this codebase/environment]
- Recommendations for next agent: [what to do differently]
\`\`\`

This is not optional — every completed job must end with this block so the namespace accumulates institutional knowledge.

### Smoke check before full implementation
Before committing to a full implementation, run a quick sanity check (\`npm test\`, \`cargo test\`, \`go test ./...\`, etc.) to verify the foundation is solid. If the quick check fails (missing deps, broken toolchain, compile errors), report the failure immediately rather than spending time on a broken foundation.

### Score reporting
At the end of your output, report your quality score:
\`\`\`
AGENT_SCORE: <float 0.0-1.0>
\`\`\`
Scoring guide:
- 1.0 = all tests pass, PR merged, task fully complete
- 0.7 = partial completion, some tests failing
- 0.4 = significant issues, task incomplete
- 0.0 = complete failure

---

`;

export const BROWSER_HINT = `\n\n## Browser Tool Available\nUse \`$B URL\` to read any live webpage via Playwright (100ms, real Chromium, ARIA refs). Example: \`$B https://github.com/owner/repo\`\n`;

export const CODE_QUALITY_CHECKLIST = `\n\n## Code Quality Checklist (check before submitting PR)\n- [ ] No LLM output used as direct code/shell input without validation\n- [ ] Async operations have error handlers (no unhandled promise rejections)\n- [ ] No secrets/tokens hardcoded — use env vars\n- [ ] Tests added for new logic\n- [ ] Build passes before PR\n`;

const CODE_TASK_PATTERN = /\b(build|implement|add|create|fix)\b/i;

export function isCodeTask(task: string): boolean {
  return CODE_TASK_PATTERN.test(task);
}

const COMPLEX_TASK_PATTERN = /\b(refactor|migrate|rewrite|redesign|architect|implement|build|add feature|integrate)\b/i;

export function isComplexTask(task: string): boolean {
  return COMPLEX_TASK_PATTERN.test(task) && task.length > 100;
}

export function injectPreamble(task: string, customPreamble?: string): string {
  const preamble = customPreamble ?? DEFAULT_PREAMBLE;
  let injected = preamble + task;
  if (isComplexTask(task)) {
    injected += `\n\n> **Planning reminder:** This looks like a complex task. Write PLAN.md and TODO.md before writing any code.\n`;
  }
  return injected;
}
