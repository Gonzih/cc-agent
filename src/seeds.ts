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
];

export async function seedBuiltinProfiles(store: ProfileStoreForSeeding): Promise<void> {
  for (const profile of BUILTIN_PROFILES) {
    const existing = await store.getProfile(profile.name);
    if (!existing) {
      await store.saveProfile({ ...profile, createdAt: new Date().toISOString() });
    }
  }
}

export { BUILTIN_PROFILES };
