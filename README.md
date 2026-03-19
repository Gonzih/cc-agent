# cc-agent

**v0.1.11** — MCP server that lets you spawn Claude Code as background agent jobs inside GitHub repositories.

You (or another Claude instance) act as the manager: delegate coding tasks to agents running in isolated cloned repos, monitor their progress, and steer them mid-task if needed.

## How it works

1. Call `spawn_agent` with a repo URL and task — returns a `job_id` immediately
2. cc-agent clones the repo into a temp dir, optionally creates a branch, then runs `claude --print --output-format stream-json --dangerously-skip-permissions` on the task
3. Poll progress with `get_job_output`, steer with `send_message`, cancel with `cancel_job`
4. Jobs and logs persist in `.cc-agent/` — they survive MCP server restarts

## Installation

```bash
# Global install
npm install -g @gonzih/cc-agent

# Or run directly via npx (no install needed)
npx @gonzih/cc-agent
```

**Prerequisite:** Claude Code (`claude` CLI) must be installed and available on `PATH`.

## MCP config

Add to your `~/.claude.json` (or wherever your Claude Code MCP config lives):

```json
{
  "mcpServers": {
    "cc-agent": {
      "command": "npx",
      "args": ["@gonzih/cc-agent"],
      "env": {
        "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-..."
      }
    }
  }
}
```

Restart Claude Code after editing the config.

## Environment variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude OAuth token (`sk-ant-oat01-...`) — recommended |
| `CLAUDE_CODE_TOKEN` | Alias for the OAuth token |
| `ANTHROPIC_API_KEY` | Anthropic API key (`sk-ant-api03-...`) — alternative |

Per-job token override is available via the `claude_token` argument on `spawn_agent`.

## MCP tools

### `spawn_agent`

Clone a git repo and run Claude Code on a task inside it. Returns immediately with a `job_id`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo_url` | string | yes | Git repository URL to clone (https or ssh) |
| `task` | string | yes | Task description to pass to Claude Code |
| `branch` | string | no | Existing branch to check out after cloning |
| `create_branch` | string | no | New branch name to create before running the task |
| `claude_token` | string | no | Per-job token override (OAuth or API key) |
| `continue_session` | boolean | no | Pass `--continue` to resume the most recent Claude session in that repo dir (default: false) |
| `max_budget_usd` | number | no | Max USD budget for this Claude session (default: 20) |

```json
spawn_agent({
  "repo_url": "https://github.com/yourorg/yourrepo",
  "task": "Fix the failing tests in src/parser.ts and open a PR with the fix",
  "create_branch": "agent/fix-parser-tests"
})
// → { "job_id": "abc-123", "status": "started", "message": "Agent spawned. Use get_job_output to follow progress." }
```

### `get_job_output`

Stream output from a job. Use `offset` for pagination — pass back `next_offset` on each call to get only new lines.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `job_id` | string | yes | Job ID from `spawn_agent` |
| `offset` | number | no | Line offset to start reading from (default: 0) |

Returns: `{ lines, next_offset, done, tool_calls }` — `done` is true when the job has finished. `tool_calls` lists the tool names the agent has invoked (last 50).

### `get_job_status`

Get the current status of a job without fetching output lines.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `job_id` | string | yes | Job ID from `spawn_agent` |

Returns: `{ job_id, status, repo_url, task, branch, create_branch, started_at, finished_at, exit_code, error, output_lines }`

Status values: `cloning` | `running` | `done` | `failed` | `cancelled`

### `list_jobs`

List all jobs (running, done, failed, cancelled). No parameters.

Returns an array of job summaries including status, exit code, error, and the 10 most recent tool calls per job.

### `send_message`

Send text to a running agent's stdin — useful for mid-task corrections or new instructions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `job_id` | string | yes | Job ID of the running agent |
| `message` | string | yes | Text to deliver to the agent |

### `cancel_job`

Kill a running job.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `job_id` | string | yes | Job ID to cancel |

### `get_version`

Returns the current cc-agent MCP server version. No parameters.

## Key features

**Persistent job storage** — Job metadata is written to `.cc-agent/jobs.json` and per-job logs to `.cc-agent/jobs/<id>.log` in the working directory. Jobs survive MCP server restarts. If a job's PID is no longer alive after restart, it's marked `failed` automatically.

**tool_calls tracking** — Every tool invocation by the agent (e.g. `Read`, `Edit`, `Bash`) is captured and surfaced in `get_job_output` and `list_jobs`, giving you visibility into what the agent is actually doing.

**Budget control** — `max_budget_usd` is forwarded to Claude Code via `--max-budget-usd`. Default is $20/job.

**Disk-backed logs** — Output is appended to `.cc-agent/jobs/<id>.log` as it streams. Logs are readable even after the in-memory job expires.

**Automatic cleanup** — Temp clone dirs are deleted 10 minutes after a job finishes. In-memory job records expire after 1 hour; log files on disk are retained.

## Agent delegation pattern

The intended mental model is manager/worker:

1. **Spawn agents for anything touching codebases.** One agent per task, one task per repo branch.
2. **Include PR instructions in the task.** Agents can open PRs and request merges via `gh`:
   ```
   task: "Refactor the auth module to use JWT. Create branch agent/jwt-auth,
          open a PR when done, and request a review. Use gh cli to create the PR."
   ```
3. **Monitor with `list_jobs` / `get_job_output`.** Check `done` flag and `tool_calls` to track progress.
4. **Steer mid-task with `send_message`.** If you see the agent going in the wrong direction, send a correction without cancelling the job.
5. **Keep agents working until done.** Jobs are background processes — you can start several in parallel and check on them at your own pace.

## Related

- [cc-tg](https://github.com/Gonzih/cc-tg) — Claude Code Telegram bot (same author)

## Credits

Built by [@Gonzih](https://github.com/Gonzih)
