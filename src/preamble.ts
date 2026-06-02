export function getPreamble(): string {
  const iso = new Date().toISOString();
  const human = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return `## cc-agent workflow (auto-injected — read this first)

**Current date and time: ${iso} (${human})**

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
4. \`git add -A\` then run \`git diff --staged\` — read the full diff, verify every change matches your stated intent. If anything is out of scope, wrong, or missing: fix it before committing. Never assume the output is correct.
5. \`git commit -m "descriptive message"\`
6. \`git push -u origin <branch>\`
7. \`gh pr create --title "..." --body "..." --base main\`
8. \`gh pr merge --squash --auto\`
9. Publish/release (language-appropriate):
   - Node/TS: \`npm version patch && npm publish\`
   - Rust: \`cargo publish\`
   - Go: \`git tag vX.Y.Z && git push --tags\`

### Rules
- NEVER work directly on main — always use a branch
- NEVER use \`create_branch\` parameter — you create your own branch with git checkout
- Nothing is done until PR is merged AND package is published/deployed
- If a step fails, fix the root cause — do not skip or bypass
- **Always review \`git diff --staged\` before committing** — verify the diff matches your stated intent exactly. Out-of-scope changes, regressions, or missing pieces must be fixed before committing. Build passing is not verification.
- Check off TODO.md items as you complete them — this is your progress tracker
- Run tests/lint ONLY when you think you're done — never mid-edit
- If you discover the plan is wrong mid-implementation, update PLAN.md before pivoting

### npm security (apply before any npm install or publish)
- Run \`npm audit\` before installing dependencies and fix any high/critical vulnerabilities
- Verify \`package.json\` dependencies haven't changed unexpectedly before installing
- Pin exact versions (remove \`^\` and \`~\` prefixes) for security-critical packages
- Use \`npm install --ignore-scripts\` for packages from untrusted sources

### Learnings (REQUIRED — write this at the end of every job)
At the very end of your output, write a \`## LEARNINGS\` section.

You will be given existing learnings for this namespace above (under "Institutional Knowledge").
Your job: produce a SINGLE compressed block that merges old + new observations.

Rules:
- Start from the existing learnings (shown above) — don't ignore them
- Add new observations from this job
- Remove duplicates (prefer newer info on conflicts)
- Remove vague or obvious statements
- Keep specific: commands, file paths, env vars, version numbers, error messages
- Max 20 bullets, tagged: [env] [toolchain] [pattern] [gotcha] [workflow] [bug]
- This compressed block REPLACES the old learnings — write it as if it's the new ground truth

Format:
\`\`\`
## LEARNINGS
- [tag] specific observation
- [tag] specific observation
...
\`\`\`

### Smoke check before full implementation
Before committing to a full implementation, run a quick sanity check (\`npm test\`, \`cargo test\`, \`go test ./...\`, etc.) to verify the foundation is solid. If the quick check fails (missing deps, broken toolchain, compile errors), report the failure immediately rather than spending time on a broken foundation.

### Profiles (reusable spawn configs)
If you have cc-agent MCP access and need to spawn sub-agents, use \`list_profiles\` to see available profiles, then \`spawn_from_profile\` to use one.
Built-in profiles: coder, fix-issue, implement-feature, write-tests, security-audit, refactor, review-pr, bump-deps
Use the \`coder\` profile when spawning agents for general coding tasks — it injects Karpathy discipline guidelines.

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
}

export const BROWSER_HINT = `\n\n## Browser Tool Available\nUse \`$B URL\` to read any live webpage via Playwright (100ms, real Chromium, ARIA refs). Example: \`$B https://github.com/owner/repo\`\n`;

export const CODE_QUALITY_CHECKLIST = `\n\n## Code Quality Checklist (check before submitting PR)\n- [ ] Ran \`git diff --staged\` and confirmed every change matches stated intent\n- [ ] No LLM output used as direct code/shell input without validation\n- [ ] Async operations have error handlers (no unhandled promise rejections)\n- [ ] No secrets/tokens hardcoded — use env vars\n- [ ] Tests added for new logic\n- [ ] Build passes before PR\n`;

const CODE_TASK_PATTERN = /\b(build|implement|add|create|fix)\b/i;

export function isCodeTask(task: string): boolean {
  return CODE_TASK_PATTERN.test(task);
}

const COMPLEX_TASK_PATTERN = /\b(refactor|migrate|rewrite|redesign|architect|implement|build|add feature|integrate)\b/i;

export function isComplexTask(task: string): boolean {
  return COMPLEX_TASK_PATTERN.test(task) && task.length > 100;
}

export function injectPreamble(task: string, customPreamble?: string, noPreamble?: boolean, effortLevel?: string, fastMode?: boolean): string {
  let prefix = "";
  if (effortLevel) prefix += `/effort ${effortLevel}\n`;
  if (fastMode) prefix += `/fast\n`;
  if (noPreamble) return prefix + task;
  const preamble = customPreamble ?? getPreamble();
  let injected = prefix + preamble + task;
  if (isComplexTask(task)) {
    injected += `\n\n> **Planning reminder:** This looks like a complex task. Write PLAN.md and TODO.md before writing any code.\n`;
  }
  return injected;
}

/** Return just the preamble text that would be prepended (for logging). */
export function getPreambleText(customPreamble?: string, noPreamble?: boolean): string {
  if (noPreamble) return "";
  return customPreamble ?? getPreamble();
}
