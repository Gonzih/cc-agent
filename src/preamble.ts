export const DEFAULT_PREAMBLE = `## cc-agent workflow (auto-injected — read this first)

You are running inside a temporary git clone of the repository. Follow this workflow exactly:

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

### npm security (apply before any npm install or publish)
- Run \`npm audit\` before installing dependencies and fix any high/critical vulnerabilities
- Verify \`package.json\` dependencies haven't changed unexpectedly before installing
- Pin exact versions (remove \`^\` and \`~\` prefixes) for security-critical packages
- Use \`npm install --ignore-scripts\` for packages from untrusted sources

---

`;

export function injectPreamble(task: string, customPreamble?: string): string {
  const preamble = customPreamble ?? DEFAULT_PREAMBLE;
  return preamble + task;
}
