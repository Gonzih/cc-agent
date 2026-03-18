# cc-agent

MCP server for spawning Claude Code agents in cloned repos. Give Claude Code the ability to **branch itself** — clone a repo and kick off a sub-agent to work on it autonomously.

## What it does

Exposes 5 MCP tools:

| Tool | Description |
|------|-------------|
| `spawn_agent` | Clone a git repo and run Claude Code on a task inside it |
| `get_job_status` | Check status of a spawned job |
| `get_job_output` | Stream output lines from a job |
| `list_jobs` | List all jobs |
| `cancel_job` | Cancel a running job |

Claude submits a job → cc-agent clones the repo → starts Claude Code in it with the task → returns immediately with a job ID → caller polls for output.

## Quickstart

```bash
# Add to Claude Code MCP config
claude mcp add cc-agent -- npx @gonzih/cc-agent
```

Set one of:
```bash
CLAUDE_CODE_TOKEN=sk-ant-oat01-...    # OAuth token
ANTHROPIC_API_KEY=sk-ant-api03-...    # API key
```

Then restart Claude Code.

## Example usage (from within Claude Code)

```
spawn_agent({
  repo_url: "https://github.com/yourorg/yourrepo",
  task: "Find all TODO comments and create a summary in TODO_SUMMARY.md",
  create_branch: "agent/todo-summary"
})
// → { job_id: "abc-123", status: "started" }

get_job_output({ job_id: "abc-123" })
// → { lines: ["[cc-agent] Cloning...", "..."], done: false }
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_TOKEN` | Claude OAuth token (sk-ant-oat01-...) |
| `ANTHROPIC_API_KEY` | Anthropic API key (sk-ant-api03-...) |

Per-job token override available via `claude_token` argument on `spawn_agent`.

## MCP config example

```json
{
  "cc-agent": {
    "command": "npx",
    "args": ["@gonzih/cc-agent"],
    "env": {
      "ANTHROPIC_API_KEY": "sk-ant-api03-..."
    }
  }
}
```

## How it works

1. `spawn_agent` creates a job and returns immediately
2. In background: `git clone --depth 1 <repo>` into a temp dir
3. Optionally checks out a branch or creates a new one
4. Runs `claude --print --output-format stream-json --dangerously-skip-permissions "<task>"`
5. Streams output into job record
6. Temp dir cleaned up 10 minutes after job finishes
7. Jobs expire after 1 hour

## Related

- [cc-tg](https://github.com/Gonzih/cc-tg) — Claude Code Telegram bot (same author)
