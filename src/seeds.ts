import type { Profile } from "./store.js";

export interface ProfileStoreForSeeding {
  getProfile(name: string): Promise<Profile | null>;
  saveProfile(profile: Profile): Promise<void>;
}

const BUILTIN_PROFILES: Omit<Profile, "createdAt">[] = [
  {
    name: "fix-issue",
    repoUrl: "",
    taskTemplate: `Fix GitHub issue #{{issue_number}}: {{issue_title}}

Read the issue carefully. Reproduce if possible. Fix the root cause.
Write or update tests. Keep changes minimal and focused.
issue_url: {{issue_url}}`,
    defaultBudgetUsd: 15,
    description: "Fix a GitHub issue. Vars: issue_number, issue_title, issue_url",
    builtin: true,
  },
  {
    name: "implement-feature",
    repoUrl: "",
    taskTemplate: `Implement: {{feature_description}}

Keep scope minimal. One feature, done properly.
Write tests. Update docs only if there's an existing docs file for this area.`,
    defaultBudgetUsd: 20,
    description: "Implement a scoped feature. Vars: feature_description",
    builtin: true,
  },
  {
    name: "write-tests",
    repoUrl: "",
    taskTemplate: `Write comprehensive tests for: {{target}}

Focus on: edge cases, error paths, integration points.
Do not modify the implementation unless you find a genuine bug.
Target coverage: {{coverage_target|80}}%`,
    defaultBudgetUsd: 10,
    description: "Write tests for a module/function/file. Vars: target, coverage_target (optional, default 80)",
    builtin: true,
  },
  {
    name: "security-audit",
    repoUrl: "",
    taskTemplate: `Security audit of: {{scope}}

Check for: injection vulnerabilities, auth bypasses, insecure defaults,
exposed secrets, dependency vulnerabilities, input validation gaps.
Report findings as GitHub issues or inline comments. Fix critical issues directly.`,
    defaultBudgetUsd: 15,
    description: "Security audit a module or the whole repo. Vars: scope",
    builtin: true,
  },
  {
    name: "refactor",
    repoUrl: "",
    taskTemplate: `Refactor: {{target}}

Goal: {{goal}}

Rules: no new features, no behavior changes, tests must still pass.
Reduce complexity. Remove duplication. Improve names.`,
    defaultBudgetUsd: 15,
    description: "Refactor a specific target. Vars: target, goal",
    builtin: true,
  },
  {
    name: "review-pr",
    repoUrl: "",
    taskTemplate: `Review PR #{{pr_number}}: {{pr_title}}

Check: correctness, edge cases, test coverage, security, performance.
Post review comments via gh cli. Approve if looks good, request changes if not.
pr_url: {{pr_url}}`,
    defaultBudgetUsd: 8,
    description: "Review a GitHub PR. Vars: pr_number, pr_title, pr_url",
    builtin: true,
  },
  {
    name: "bump-deps",
    repoUrl: "",
    taskTemplate: `Update dependencies in this repo.

Run the package manager's update command. Check for breaking changes in changelogs.
Fix any breakage. Run tests. Commit if green.`,
    defaultBudgetUsd: 10,
    description: "Bump all dependencies, fix breakage, run tests",
    builtin: true,
  },
  {
    name: "coder",
    repoUrl: "",
    taskTemplate: "{{task}}",
    defaultBudgetUsd: 20,
    description: "General coding agent — Karpathy discipline: think before coding, simplicity first, surgical changes",
    builtin: true,
    preamble: `# Coding Guidelines (Karpathy discipline)

Behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.`,
  },
];

export async function seedBuiltinProfiles(store: ProfileStoreForSeeding): Promise<void> {
  for (const profile of BUILTIN_PROFILES) {
    const existing = await store.getProfile(profile.name);
    if (!existing) {
      await store.saveProfile({ ...profile, createdAt: new Date().toISOString() });
    } else if (existing.builtin === true) {
      // Always overwrite stale builtin definitions with the latest version
      await store.saveProfile({ ...profile, createdAt: existing.createdAt });
    }
  }
}

export { BUILTIN_PROFILES };
