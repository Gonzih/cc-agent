# cc-agent

<img src="assets/logo.png" alt="AMAI" width="120">

[![npm version](https://img.shields.io/npm/v/@gonzih/cc-agent?label=@gonzih/cc-agent)](https://www.npmjs.com/package/@gonzih/cc-agent)

MCP server for spawning Claude Code agents in GitHub repos. Give Claude Code the ability to **branch itself** — clone a repo and kick off a sub-agent to work on it autonomously, with persistent state across MCP restarts.

Built by [@Gonzih](https://github.com/Gonzih).

## Quickstart

```bash
claude mcp add cc-agent -- npx @gonzih/cc-agent
```

Set one of:
```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # OAuth token (recommended)
ANTHROPIC_API_KEY=sk-ant-api03-...         # API key
```

Restart Claude Code. You now have 13 new MCP tools.

## MCP Tools

| Tool | Description |
|------|-------------|
| `spawn_agent` | Clone a repo, optionally create a branch, run Claude Code on a task |
| `get_job_status` | Check status of a specific job |
| `get_job_output` | Stream output lines from a job (supports offset for tailing) |
| `list_jobs` | List all jobs with status, recent tool calls, and exit info |
| `cancel_job` | Kill a running job |
| `send_message` | Write a message to a running agent's stdin mid-task |
| `cost_summary` | Total USD cost across all jobs, broken down by repo |
| `get_version` | Return the running cc-agent version |
| `create_plan` | Spawn a dependency graph of agent jobs in one call |
| `create_profile` | Save a named spawn config for repeated use with `{{variable}}` templates |
| `list_profiles` | List all saved profiles |
| `delete_profile` | Delete a named profile |
| `spawn_from_profile` | Spawn a job from a saved profile with variable interpolation |

## spawn_agent parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo_url` | string | yes | Git repo to clone (HTTPS or SSH) |
| `task` | string | yes | Task prompt for Claude Code |
| `branch` | string | no | Existing branch to check out after clone |
| `create_branch` | string | no | New branch to create (e.g. `feat/my-feature`) |
| `claude_token` | string | no | Per-job token override |
| `continue_session` | boolean | no | Pass `--continue` to resume last Claude session in workdir |
| `max_budget_usd` | number | no | Spend cap in USD (default: 20) |
| `session_id` | string | no | Session ID from a prior job's `sessionIdAfter` — resumes that session |
| `depends_on` | string[] | no | Job IDs that must be `done` before this job starts (queued as `pending`) |

## create_plan parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `goal` | string | yes | High-level description of what this plan achieves |
| `steps` | array | yes | Ordered list of steps to execute |

Each step in `steps`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Logical step ID (used for `depends_on` references within the plan) |
| `repo_url` | string | yes | Git repo to clone |
| `task` | string | yes | Task prompt for Claude Code |
| `create_branch` | string | no | New branch to create before running |
| `depends_on` | string[] | no | Step IDs from this plan that must complete first |

## create_profile parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Profile name (alphanumeric, dashes, underscores) |
| `repo_url` | string | yes | Git repo to clone |
| `task_template` | string | yes | Task template — use `{{varName}}` for substitution |
| `default_budget_usd` | number | no | Default USD budget for jobs from this profile |
| `branch` | string | no | Branch to check out after cloning |
| `description` | string | no | Human-readable profile description |

## spawn_from_profile parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `profile_name` | string | yes | Name of the saved profile to use |
| `vars` | object | no | Variables to interpolate into the task template |
| `task_override` | string | no | Use this task instead of the profile template |
| `branch_override` | string | no | Override the profile's branch |
| `budget_override` | number | no | Override the profile's default budget |

## Usage examples

### Basic agent

```
spawn_agent({
  repo_url: "https://github.com/yourorg/yourrepo",
  task: "Add error handling to all API endpoints. Open a PR when done.",
  create_branch: "feat/error-handling",
  max_budget_usd: 5
})
// → { job_id: "abc-123", status: "started" }

list_jobs()
// → [{ id: "abc-123", status: "running", recentTools: ["Read", "Edit", "Bash", ...] }]

get_job_output({ job_id: "abc-123", offset: 0 })
// → { lines: ["[cc-agent] Cloning...", "Reading src/api.ts...", ...], done: false }

send_message({ job_id: "abc-123", message: "Also update the tests." })
// → { sent: true }

cost_summary()
// → { totalJobs: 1, totalCostUsd: 1.23, byRepo: { "https://github.com/...": 1.23 } }
```

### Multi-step plan with dependencies

```
create_plan({
  goal: "Refactor auth and update docs",
  steps: [
    {
      id: "refactor",
      repo_url: "https://github.com/yourorg/app",
      task: "Refactor auth middleware to use JWT. Open a PR.",
      create_branch: "feat/jwt-auth"
    },
    {
      id: "docs",
      repo_url: "https://github.com/yourorg/app",
      task: "Update README to document the new JWT auth flow.",
      create_branch: "docs/jwt-auth",
      depends_on: ["refactor"]
    }
  ]
})
// → { goal: "...", totalSteps: 2, steps: [{ stepId: "refactor", jobId: "abc-1", status: "cloning" }, { stepId: "docs", jobId: "abc-2", status: "pending" }] }
```

### Profiles for repeated tasks

```
// Save once:
create_profile({
  name: "fix-issue",
  repo_url: "https://github.com/yourorg/app",
  task_template: "Fix issue #{{issue}}: {{title}}. Open a PR when done.",
  default_budget_usd: 5
})

// Use many times:
spawn_from_profile({
  profile_name: "fix-issue",
  vars: { issue: "42", title: "Login broken on mobile" }
})
```

### Resume a prior session

```
// Get session ID from a completed job:
get_job_status({ job_id: "abc-123" })
// → { ..., session_id_after: "ses_xyz" }

// Resume it:
spawn_agent({
  repo_url: "https://github.com/yourorg/app",
  task: "Continue where you left off — finish the tests.",
  session_id: "ses_xyz"
})
```

## Persistence

cc-agent v0.3.0+ stores all job state in **Redis**, which is auto-provisioned on startup — zero configuration needed.

### Auto-provisioning

On startup, cc-agent tries to connect to Redis at `localhost:6379`. If unavailable:

1. **Docker** — runs `docker run -d --name cc-agent-redis -p 6379:6379 --restart=unless-stopped redis:alpine`
2. **redis-server** — if `redis-server` is on PATH, spawns it as a daemon
3. **In-memory fallback** — logs a warning and continues; jobs are not persisted across restarts

Once Redis is available, all job state, output, profiles, and plans survive MCP server restarts and are **shared across all Claude Code sessions** pointing at the same Redis instance.

### Key schema

| Key | Type | TTL | Contents |
|-----|------|-----|----------|
| `cca:job:<id>` | String (JSON) | 7 days | Full job record |
| `cca:jobs:index` | List | — | Job IDs, newest first (capped at 500) |
| `cca:job:<id>:output` | List | 7 days | Output lines (one entry per line) |
| `cca:plan:<id>` | String (JSON) | 30 days | Plan record with step→job mapping |
| `cca:profile:<name>` | String (JSON) | permanent | Profile config |
| `cca:profiles:index` | Set | permanent | All profile names |

### Disk fallback

When Redis is unavailable, cc-agent falls back to the original disk-based storage:

- `.cc-agent/jobs.json` — job metadata
- `.cc-agent/jobs/<id>.log` — per-job output log
- `~/.cc-agent/profiles.json` — profiles

Existing disk profiles are automatically migrated to Redis on first startup with Redis available.

## Job statuses

| Status | Meaning |
|--------|---------|
| `pending` | Waiting for `depends_on` jobs to complete |
| `cloning` | Cloning the repo |
| `running` | Claude Code is running |
| `done` | Completed successfully |
| `failed` | Exited with an error (check `error` field) |
| `cancelled` | Cancelled by `cancel_job` |

## Tool call visibility

`list_jobs` returns `recentTools` — the last 10 tool names Claude called per job (e.g. `["Read", "Edit", "Bash", "Glob"]`). `get_job_output` returns the full `tool_calls` array. This gives insight into what agents are actually doing during silent periods.

## Budget control

Set `max_budget_usd` per job to cap spend. Default is $20. Claude Code is killed with SIGTERM when the budget is exhausted (exit code 143).

```
spawn_agent({ ..., max_budget_usd: 10 })  // up to $10 for this task
spawn_agent({ ..., max_budget_usd: 2  })  // quick/cheap task
```

## Agent delegation pattern

The recommended mental model: **you are the tech lead, agents are your team**.

- Spawn agents for any task touching a codebase (multiple files, running tests, opening PRs)
- Do research, quick edits, and orchestration yourself
- Always end agent prompts with the terminal steps: `gh pr create → gh pr merge → npm publish` (or whatever ships the work)
- Monitor with `list_jobs` + `get_job_output`, respawn if budget runs out

```
# Standard agent task prompt ending:
gh pr create --title "feat: ..." --body "..." --base main
gh pr merge --squash --auto
npm version patch && npm publish   # if it's a library
```

## MCP config (claude.json)

```json
{
  "cc-agent": {
    "command": "npx",
    "args": ["@gonzih/cc-agent"],
    "env": {
      "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-..."
    }
  }
}
```

## How it works

1. `spawn_agent` creates a job record (persisted to disk) and returns immediately with a job ID
2. In background: `git clone --depth 1 <repo>` into a temp dir
3. Optionally checks out an existing branch or creates a new one
4. Runs `claude --print --output-format stream-json --verbose --dangerously-skip-permissions --max-budget-usd <N> <task>`
5. Streams stdout/stderr into the job's output log (in memory + disk)
6. Tool calls are captured from the stream-JSON and stored in `tool_calls[]`
7. On exit: job marked done/failed, workdir cleaned up after 10 minutes
8. Jobs expire from memory after 1 hour (log file remains on disk)
9. Pending jobs are promoted automatically every 3 seconds when their dependencies complete

## Environment variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_TOKEN` | Claude OAuth token or Anthropic API key |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude OAuth token (alternative) |
| `ANTHROPIC_API_KEY` | Anthropic API key (alternative) |

## Requirements

- Node.js 18+
- `claude` CLI: `npm install -g @anthropic-ai/claude-code`
- Git

## Related

- [cc-tg](https://github.com/Gonzih/cc-tg) — Claude Code Telegram bot by [@Gonzih](https://github.com/Gonzih)
