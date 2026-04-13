#!/usr/bin/env node
/**
 * cc-agent — MCP server for spawning Claude Code agents in cloned repos
 *
 * Usage (stdio MCP):
 *   npx @gonzih/cc-agent
 *
 * Optional env:
 *   CLAUDE_CODE_TOKEN   — Claude OAuth token or Anthropic API key
 *   ANTHROPIC_API_KEY   — alternative API key
 *
 * MCP tools exposed:
 *   spawn_agent       — clone a repo and run Claude on a task
 *   get_job_status    — check job status
 *   get_job_output    — stream job output
 *   list_jobs         — list all jobs
 *   cancel_job        — cancel a running job
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { JobManager, repoKey, normalizeRepoUrl } from "./agent.js";
import { MetaAgentManager } from "./meta-agent.js";
import { buildEvaluatorTask } from "./evaluator.js";
import { loadProfiles, upsertProfile, deleteProfile, getProfile, interpolate } from "./profiles.js";
import { planStore, jobStore, learningsStore } from "./store.js";
import { getNamespace } from "./namespace.js";
import { initRedis, getRedis } from "./redis.js";
import { logger } from "./logger.js";
import { Coordinator } from "./coordinator.js";
import { CronEngine } from "./cron.js";
import { listCcAgentContainers } from "./docker.js";
import { loadTokens, getTokenStatus } from "./tokens.js";
import { v4 as uuidv4 } from "uuid";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { createRequire } from "module";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json") as { version: string };

const token =
  process.env.CLAUDE_CODE_TOKEN ??
  process.env.CLAUDE_CODE_OAUTH_TOKEN ??
  process.env.ANTHROPIC_API_KEY;

/** Trusted GitHub owners who can trigger jobs without approval. */
const TRUSTED_OWNERS: string[] = (process.env.CC_AGENT_TRUSTED_OWNERS ?? "gonzih")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/** Extract the GitHub owner from a repo URL (https or ssh). Returns null if not parseable. */
function extractGithubOwner(repoUrl: string): string | null {
  // https://github.com/owner/repo or https://github.com/owner/repo.git
  const httpsMatch = repoUrl.match(/github\.com\/([^/]+)\//);
  if (httpsMatch) return httpsMatch[1];
  // git@github.com:owner/repo.git
  const sshMatch = repoUrl.match(/github\.com:([^/]+)\//);
  if (sshMatch) return sshMatch[1];
  return null;
}

const manager = new JobManager(token);
const namespace = getNamespace();
const coordinator = new Coordinator(manager, namespace);
const cronEngine = new CronEngine(manager, namespace);
const metaAgentManager = new MetaAgentManager();

const server = new Server(
  { name: "cc-agent", version: PKG_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "spawn_agent",
      description:
        "Spawn a Claude Code agent on a GitHub repository.\n\nWORKFLOW: agent clones repo → creates its own branch → implements → tests → commits → pushes → opens PR → merges PR → publishes.\n\nIMPORTANT: Always set create_branch: false. The agent creates its own branch internally with `git checkout -b`. Setting create_branch: true will cause a clone failure because the branch doesn't exist on remote yet.\n\nParameters:\n- repo_url: GitHub repo URL (https://github.com/owner/repo)\n- task: Full task description. A workflow preamble is auto-injected before your task.\n- create_branch: ALWAYS false. The agent manages its own branch.\n- branch: Branch name hint passed to agent (agent will create it with git checkout -b)\n- claude_token: Optional Claude API token override",
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Git repository URL to clone (https or ssh)",
          },
          task: {
            type: "string",
            description: "Task description to pass to Claude Code. A workflow preamble is auto-injected before this task.",
          },
          branch: {
            type: "string",
            description: "Branch name hint passed to the agent (agent will create it with git checkout -b). Optional.",
          },
          create_branch: {
            type: "string",
            description: "ALWAYS false. The agent creates its own branch with git checkout -b. Setting this to a branch name will cause a clone failure because the branch does not exist on remote yet.",
          },
          claude_token: {
            type: "string",
            description:
              "Claude OAuth token or Anthropic API key to use for this job (optional — falls back to server env)",
          },
          continue_session: {
            type: "boolean",
            description:
              "Pass --continue to Claude Code to resume the most recent session in the repo directory (optional, default false)",
          },
          max_budget_usd: {
            type: "number",
            description:
              "Maximum USD budget for this Claude Code session (optional, default 20)",
          },
          session_id: {
            type: "string",
            description:
              "Session ID to resume from a previous job (use sessionIdAfter from a prior job). Passes --continue to Claude CLI.",
          },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description:
              "Job IDs that must be done before this job starts. Job will be queued as pending until all dependencies complete.",
          },
          model: {
            type: "string",
            description:
              "Model override for this job (e.g. 'claude-sonnet-4-5'). Defaults to CC_AGENT_DEFAULT_MODEL env var or 'claude-sonnet-4-5'.",
          },
          ollama_model: {
            type: "string",
            description:
              "If set, route Claude Code through Ollama using this model name (e.g. 'nemotron-3-nano', 'deepseek-r1:7b'). Sets ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY=ollama, and CLAUDE_MODEL env vars.",
          },
          ollama_host: {
            type: "string",
            description:
              "Ollama host URL (default: 'http://localhost:11434'). Only used when ollama_model is set.",
          },
          docker_isolation: {
            type: "boolean",
            description:
              "Run agent in Docker container for isolation. Default: false. Requires Docker to be running. On macOS, Docker runs in a VM — use only when isolation is specifically needed.",
          },
          smoke_test: {
            type: "string",
            description:
              "Shell command to run as a cheap pre-check before the full task. If it exits non-zero or times out, the job fails immediately. Example: 'npm test -- --testPathPattern=smoke 2>&1 | tail -5'",
          },
          smoke_test_timeout: {
            type: "number",
            description:
              "Timeout for the smoke test in seconds (default 60). Only used when smoke_test is set.",
          },
          coordinator_plan: {
            type: "object",
            description: "Optional plan for cc-tg coordinator. If set, cc-tg will spawn the nextStep when this job completes.",
            properties: {
              next_step: {
                type: "object",
                properties: {
                  repo_url: { type: "string" },
                  task: { type: "string" },
                },
              },
              summary: {
                type: "string",
                description: "Human-readable description of what this job is part of",
              },
            },
          },
        },
        required: ["repo_url", "task"],
      },
    },
    {
      name: "get_job_status",
      description: "Get the current status of a spawned agent job.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Job ID returned by spawn_agent" },
        },
        required: ["job_id"],
      },
    },
    {
      name: "get_job_output",
      description:
        "Get output lines from a running or finished job. Use offset to paginate.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Job ID returned by spawn_agent" },
          offset: {
            type: "number",
            description: "Line offset to start from (default 0)",
          },
        },
        required: ["job_id"],
      },
    },
    {
      name: "list_jobs",
      description: "List all agent jobs (running, done, failed, cancelled).",
      inputSchema: {
        type: "object",
        properties: {
          min_score: {
            type: "number",
            description: "Only return jobs with score >= this value (0.0–1.0). Unscored jobs are excluded when this filter is set.",
          },
        },
      },
    },
    {
      name: "cancel_job",
      description: "Cancel a running agent job.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Job ID to cancel" },
        },
        required: ["job_id"],
      },
    },
    {
      name: "send_message",
      description: "Send a message to a running agent's stdin. Use this to give the agent corrections, new information, or updated instructions mid-task.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description: "The job ID of the running agent",
          },
          message: {
            type: "string",
            description: "The message to send to the agent",
          },
        },
        required: ["job_id", "message"],
      },
    },
    {
      name: "cost_summary",
      description: "Returns total USD cost across all jobs, broken down by repo.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_version",
      description: "Returns the running cc-agent MCP server version.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "create_profile",
      description:
        "Save a named spawn config (profile) for repeated use. Task templates support {{variable}} substitution.\n\n// Create once:\n// create_profile('fix-bugs', 'https://github.com/me/app', 'Fix {{issue}}: {{title}}', 5)\n// Use many times:\n// spawn_from_profile('fix-bugs', { issue: '42', title: 'Login broken' })",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Profile name (alphanumeric, dash, underscore only)",
          },
          repo_url: {
            type: "string",
            description: "Git repository URL to clone",
          },
          task_template: {
            type: "string",
            description: "Task description template; use {{varName}} for substitution",
          },
          default_budget_usd: {
            type: "number",
            description: "Default USD budget for jobs spawned from this profile (optional)",
          },
          branch: {
            type: "string",
            description: "Branch to checkout after cloning (optional)",
          },
          description: {
            type: "string",
            description: "Human-readable description of this profile (optional)",
          },
          preamble: {
            type: "string",
            description: "Custom workflow preamble to inject before every task spawned from this profile. Overrides the default preamble (optional).",
          },
        },
        required: ["name", "repo_url", "task_template"],
      },
    },
    {
      name: "list_profiles",
      description: "List all saved named job profiles.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "delete_profile",
      description: "Delete a named job profile.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Profile name to delete" },
        },
        required: ["name"],
      },
    },
    {
      name: "create_plan",
      description:
        "Spawn a full dependency graph of agent jobs in one call. Each step can declare depends_on referencing other step IDs in this plan. Returns a summary with actual job IDs mapped to step IDs.",
      inputSchema: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "High-level description of what this plan achieves",
          },
          steps: {
            type: "array",
            description: "Ordered list of steps to execute",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "Logical step ID used for depends_on references within this plan",
                },
                repo_url: {
                  type: "string",
                  description: "Git repository URL to clone",
                },
                task: {
                  type: "string",
                  description: "Task description to pass to Claude Code",
                },
                create_branch: {
                  type: "string",
                  description: "New branch name to create before running the task (optional)",
                },
                depends_on: {
                  type: "array",
                  items: { type: "string" },
                  description: "Step IDs (from this plan) that must complete before this step starts",
                },
                branches: {
                  type: "number",
                  description: "If set, spawn this many parallel variant jobs for this step instead of 1. An evaluator job is automatically added to score and select the best variant.",
                },
                branch_eval: {
                  type: "string",
                  enum: ["test_pass_rate", "pr_merged", "manual"],
                  description: "How to score variants: test_pass_rate (parse test output), pr_merged (check PR status), manual (evaluator uses judgment). Default: test_pass_rate",
                },
                branch_select: {
                  type: "string",
                  enum: ["best_score", "score_prop", "latest"],
                  description: "How to pick the winner: best_score (highest score wins), score_prop (score-proportional random selection), latest (most recently completed). Default: best_score",
                },
              },
              required: ["id", "repo_url", "task"],
            },
          },
        },
        required: ["goal", "steps"],
      },
    },
    {
      name: "get_logs",
      description: "Return the last N lines of the cc-agent log file (~/.cc-agent/logs/cc-agent.log). Default 100, max 500.",
      inputSchema: {
        type: "object",
        properties: {
          lines: {
            type: "number",
            description: "Number of log lines to return (default 100, max 500)",
          },
        },
      },
    },
    {
      name: "wake_job",
      description: "Manually wake a sleeping job immediately, bypassing its scheduled wake time.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Job ID of a sleeping job to wake" },
        },
        required: ["job_id"],
      },
    },
    {
      name: "list_model_ratings",
      description: "Returns the content of ~/.cc-agent/model-ratings.jsonl as a structured JSON array. Used to monitor which open models (routed via Ollama) are performing well. Rating and notes fields are null until filled in by the operator.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_project_issues",
      description: "List GitHub issues for a repository using the gh CLI.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo in owner/repo format" },
          state: { type: "string", enum: ["open", "closed", "all"], description: "Issue state filter (default: open)" },
          labels: { type: "array", items: { type: "string" }, description: "Filter by labels (optional)" },
          assignee: { type: "string", description: "Filter by assignee login (optional). Uses gh --assignee flag; the returned JSON field is 'assignees' (plural)." },
        },
        required: ["repo"],
      },
    },
    {
      name: "work_on_issue",
      description: "Fetch a GitHub issue, post a pickup comment, and spawn a cc-agent to work on it.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo in owner/repo format" },
          issue_number: { type: "number", description: "Issue number to work on" },
          extra_context: { type: "string", description: "Additional context to pass to the agent (optional)" },
          max_budget_usd: { type: "number", description: "Max USD budget for the agent (optional, default 20)" },
        },
        required: ["repo", "issue_number"],
      },
    },
    {
      name: "comment_on_issue",
      description: "Post a comment on a GitHub issue.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo in owner/repo format" },
          issue_number: { type: "number", description: "Issue number to comment on" },
          body: { type: "string", description: "Comment body" },
        },
        required: ["repo", "issue_number", "body"],
      },
    },
    {
      name: "close_issue",
      description: "Close a GitHub issue, optionally posting a comment.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo in owner/repo format" },
          issue_number: { type: "number", description: "Issue number to close" },
          comment: { type: "string", description: "Comment to post when closing (optional)" },
        },
        required: ["repo", "issue_number"],
      },
    },
    {
      name: "approve_job",
      description: "Approve a job that is pending approval due to an untrusted repo owner. Transitions the job from pending_approval to running.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Job ID of the pending_approval job to approve" },
        },
        required: ["job_id"],
      },
    },
    {
      name: "set_job_score",
      description: "Set a quality score (0.0–1.0) on a completed job. Used by evaluator agents in evolutionary branching plans to record how well each variant performed.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Job ID to score" },
          score: { type: "number", description: "Score from 0.0 to 1.0" },
          reason: { type: "string", description: "Optional reason or explanation for the score" },
        },
        required: ["job_id", "score"],
      },
    },
    {
      name: "get_learnings",
      description: "Return accumulated learnings for a repo or namespace. Learnings are written by agents at the end of each job. Use this to understand what prior agents have discovered.",
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "Repo key to query, e.g. 'gonzih/cc-agent'. Takes precedence over namespace when provided.",
          },
          namespace: {
            type: "string",
            description: "Namespace to query (fallback when repo is not provided; defaults to current namespace)",
          },
          limit: {
            type: "number",
            description: "Maximum number of learnings to return (default 10)",
          },
        },
      },
    },
    {
      name: "clear_learnings",
      description: "Clear all stored learnings for a namespace. Useful when starting fresh on a refactored codebase.",
      inputSchema: {
        type: "object",
        properties: {
          namespace: {
            type: "string",
            description: "Namespace to clear learnings for (defaults to current namespace)",
          },
        },
      },
    },
    {
      name: "docker_ps",
      description: "List currently running cc-agent Docker containers. Shows container name, status, and uptime.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_token_status",
      description: "List the status of all configured OAuth tokens (CLAUDE_TOKENS env var). Shows which token is currently active and how many are configured. Useful for diagnosing token rotation issues.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "spawn_from_profile",
      description: "Spawn an agent job from a saved profile. Supports variable interpolation and per-call overrides.",
      inputSchema: {
        type: "object",
        properties: {
          profile_name: {
            type: "string",
            description: "Name of the profile to use",
          },
          vars: {
            type: "object",
            description: "Variables to interpolate into the task template (e.g. { issue: '42', title: 'Login broken' })",
            additionalProperties: { type: "string" },
          },
          task_override: {
            type: "string",
            description: "Use this task instead of the profile's template (optional)",
          },
          branch_override: {
            type: "string",
            description: "Override the profile's branch (optional)",
          },
          budget_override: {
            type: "number",
            description: "Override the profile's default budget (optional)",
          },
        },
        required: ["profile_name"],
      },
    },
    {
      name: "list_crons",
      description: "List all scheduled cron jobs for the current namespace.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "create_cron",
      description: "Create a new cron job that fires on a recurring interval and spawns an agent.",
      inputSchema: {
        type: "object",
        properties: {
          interval_ms: { type: "number", description: "Interval in milliseconds between fires" },
          prompt: { type: "string", description: "Task prompt to pass to the agent on each fire" },
          schedule: { type: "string", description: "Human-readable schedule label, e.g. 'every 30m'" },
          chat_id: { type: "number", description: "Telegram chat ID for notification routing (optional, default 0)" },
          repo_url: { type: "string", description: "Repository URL to run the cron task on (optional)" },
          enabled: { type: "boolean", description: "Whether the cron is active (optional, default true)" },
        },
        required: ["interval_ms", "prompt", "schedule"],
      },
    },
    {
      name: "delete_cron",
      description: "Delete a cron job by ID.",
      inputSchema: {
        type: "object",
        properties: {
          cron_id: { type: "string", description: "Cron job ID to delete" },
        },
        required: ["cron_id"],
      },
    },
    {
      name: "update_cron",
      description: "Update fields on an existing cron job.",
      inputSchema: {
        type: "object",
        properties: {
          cron_id: { type: "string", description: "Cron job ID to update" },
          interval_ms: { type: "number", description: "New interval in milliseconds (optional)" },
          prompt: { type: "string", description: "New prompt (optional)" },
          schedule: { type: "string", description: "New schedule label (optional)" },
          enabled: { type: "boolean", description: "Enable or disable the cron (optional)" },
        },
        required: ["cron_id"],
      },
    },
    {
      name: "list_notifications",
      description: "Return the last 20 notification messages sent by the coordinator for the current namespace.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_active_repos",
      description: "List all active namespaces/repos with job counts and recent activity. Each namespace = one project column in the UI.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_pubsub_status",
      description: "Debug: show all active Redis pub/sub channels and subscriber counts. Use to diagnose chat sync issues.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "start_meta_agent",
      description: "Clone repo (if needed) into ~/cc-agent-workspace/{namespace} and start a persistent Claude Code session there. Meta-agents are long-lived — they receive multiple messages over time and publish responses to cca:chat:outgoing:{namespace}.",
      inputSchema: {
        type: "object",
        properties: {
          namespace: {
            type: "string",
            description: "Repo short name, e.g. polly-gamba. Used as the workspace directory name and Redis key prefix.",
          },
          repo_url: {
            type: "string",
            description: "Optional GitHub URL. Defaults to https://github.com/gonzih/{namespace}",
          },
        },
        required: ["namespace"],
      },
    },
    {
      name: "message_meta_agent",
      description: "Send a message to a running meta-agent session. Enqueues to cca:meta:{namespace}:input (LPUSH). The meta-agent polls this every 3s and writes messages to Claude stdin.",
      inputSchema: {
        type: "object",
        properties: {
          namespace: { type: "string", description: "Meta-agent namespace to message" },
          message: { type: "string", description: "Message content to send to the Claude session" },
        },
        required: ["namespace", "message"],
      },
    },
    {
      name: "list_meta_agents",
      description: "List all meta-agent sessions and their status (running or stopped).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "stop_meta_agent",
      description: "Stop a running meta-agent session. Kills the Claude process and updates Redis status to stopped.",
      inputSchema: {
        type: "object",
        properties: {
          namespace: { type: "string", description: "Meta-agent namespace to stop" },
        },
        required: ["namespace"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;

  switch (name) {
    case "spawn_agent": {
      const repoUrl = normalizeRepoUrl(a.repo_url as string);
      logger.info("tool:spawn_agent", { repo_url: repoUrl, task: (a.task as string)?.slice(0, 80) });

      const owner = extractGithubOwner(repoUrl);
      const isTrusted = !owner || TRUSTED_OWNERS.includes(owner);

      const jobId = await manager.spawn({
        repoUrl,
        task: a.task as string,
        branch: a.branch as string | undefined,
        createBranch: a.create_branch as string | undefined,
        claudeToken: a.claude_token as string | undefined,
        continueSession: a.continue_session as boolean | undefined,
        maxBudgetUsd: a.max_budget_usd as number | undefined,
        sessionId: a.session_id as string | undefined,
        dependsOn: a.depends_on as string[] | undefined,
        model: a.model as string | undefined,
        ollamaModel: a.ollama_model as string | undefined,
        ollamaHost: a.ollama_host as string | undefined,
        dockerIsolation: a.docker_isolation === true, // explicit: only true when literally true
        smokeTest: a.smoke_test as string | undefined,
        smokeTestTimeout: a.smoke_test_timeout as number | undefined,
        requiresApproval: !isTrusted,
      });

      if (a.coordinator_plan) {
        const redis = getRedis();
        if (redis) {
          try {
            await redis.set(
              `cca:coordinator:plan:${jobId}`,
              JSON.stringify(a.coordinator_plan),
              'EX',
              7 * 24 * 3600,
            );
          } catch (err) {
            logger.warn("coordinator-plan:store-failed", { jobId, err: String(err) });
          }
        }
      }

      if (!isTrusted && owner) {
        // Create a GitHub issue on the repo requesting approval
        const repo = `${owner}/${repoUrl.split("/").pop()?.replace(/\.git$/, "") ?? "repo"}`;
        const approvalBody = [
          `cc-agent wants to run a task on this repo.`,
          ``,
          `**Task:** ${(a.task as string).slice(0, 500)}`,
          ``,
          `Owner @${TRUSTED_OWNERS[0]}: reply \`/approve\` to this comment to proceed.`,
          ``,
          `Job ID: \`${jobId}\``,
        ].join("\n");

        let approvalIssueUrl = "";
        let approvalIssueNumber = 0;
        try {
          const { stdout } = await execFileAsync("gh", [
            "issue", "create",
            "--repo", repo,
            "--title", `cc-agent: Approval needed for task (job ${jobId.slice(0, 8)})`,
            "--body", approvalBody,
            "--json", "number,url",
          ]);
          const issueData = JSON.parse(stdout) as { number: number; url: string };
          approvalIssueUrl = issueData.url;
          approvalIssueNumber = issueData.number;
        } catch (err) {
          logger.warn("approval-issue:create-failed", { jobId, error: String(err) });
        }

        manager.startApprovalPolling(jobId, approvalIssueUrl, repo, approvalIssueNumber);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              job_id: jobId,
              status: "pending_approval",
              message: `Owner '${owner}' is not in the trusted list. Approval required. Comment /approve on the issue to proceed.`,
              approval_issue_url: approvalIssueUrl,
            }),
          }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ job_id: jobId, status: "started", message: "Agent spawned. Use get_job_output to follow progress." }),
          },
        ],
      };
    }

    case "get_job_status": {
      logger.info("tool:get_job_status", { job_id: a.job_id });
      const job = manager.getJob(a.job_id as string);
      if (!job) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Job not found" }) }] };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              job_id: job.id,
              status: job.status,
              repo_url: job.repoUrl,
              task: job.task.slice(0, 120),
              branch: job.branch,
              create_branch: job.createBranch,
              started_at: job.startedAt.toISOString(),
              finished_at: job.finishedAt?.toISOString(),
              exit_code: job.exitCode,
              error: job.error,
              output_lines: job.output.length,
              session_id_after: job.sessionIdAfter,
              cost_usd: job.costUsd,
              usage: job.usage,
              approval_issue_url: job.approvalIssueUrl,
              score: job.score ?? null,
              score_source: job.scoreSource ?? null,
            }),
          },
        ],
      };
    }

    case "get_job_output": {
      logger.info("tool:get_job_output", { job_id: a.job_id, offset: a.offset });
      const offset = typeof a.offset === "number" ? a.offset : 0;
      const { lines, done, toolCalls } = await manager.getOutput(a.job_id as string, offset);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              job_id: a.job_id,
              offset,
              lines,
              next_offset: offset + lines.length,
              done,
              tool_calls: toolCalls,
            }),
          },
        ],
      };
    }

    case "list_jobs": {
      logger.info("tool:list_jobs");
      const minScore = typeof a.min_score === "number" ? a.min_score : undefined;
      let jobs = (await jobStore.listJobs()) ?? [];
      if (minScore !== undefined) {
        jobs = jobs.filter((j) => j.score != null && j.score >= minScore);
      }
      const namespace = getNamespace();
      const learnings_count = await learningsStore.getLearningsCount(namespace);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ jobs, total: jobs.length, namespace, learnings_count }),
          },
        ],
      };
    }

    case "cancel_job": {
      logger.info("tool:cancel_job", { job_id: a.job_id });
      const cancelled = manager.cancel(a.job_id as string);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ job_id: a.job_id, cancelled }),
          },
        ],
      };
    }

    case "send_message": {
      logger.info("tool:send_message", { job_id: a.job_id });
      const result = await manager.sendMessage(a.job_id as string, a.message as string);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.ok
              ? { job_id: a.job_id, sent: true, message: "Message queued for delivery to agent." }
              : { job_id: a.job_id, sent: false, error: result.error }),
          },
        ],
      };
    }

    case "cost_summary": {
      logger.info("tool:cost_summary");
      // Use jobStore (Redis/disk) to include all persisted jobs, not just in-memory ones
      const allRecords = await jobStore.listJobs();
      let totalCostUsd = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      const byJob: Array<{ job_id: string; repo_url: string; cost_usd: number; input_tokens: number; output_tokens: number }> = [];
      for (const r of allRecords) {
        const cost = r.costUsd ?? 0;
        const inp = r.totalInputTokens ?? 0;
        const out = r.totalOutputTokens ?? 0;
        totalCostUsd += cost;
        totalInputTokens += inp;
        totalOutputTokens += out;
        if (cost > 0 || inp > 0 || out > 0) {
          byJob.push({ job_id: r.id, repo_url: r.repoUrl, cost_usd: Math.round(cost * 10000) / 10000, input_tokens: inp, output_tokens: out });
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              total_cost_usd: Math.round(totalCostUsd * 10000) / 10000,
              total_input_tokens: totalInputTokens,
              total_output_tokens: totalOutputTokens,
              by_job: byJob,
            }),
          },
        ],
      };
    }

    case "get_version":
      logger.info("tool:get_version");
      return {
        content: [{ type: "text", text: JSON.stringify({ version: PKG_VERSION }) }],
      };

    case "create_profile": {
      logger.info("tool:create_profile", { name: a.name });
      const profileName = a.name as string;
      if (!/^[\w-]+$/.test(profileName)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Profile name must be alphanumeric with dashes/underscores only" }) }],
        };
      }
      await upsertProfile({
        name: profileName,
        repoUrl: normalizeRepoUrl(a.repo_url as string),
        taskTemplate: a.task_template as string,
        defaultBudgetUsd: a.default_budget_usd as number | undefined,
        branch: a.branch as string | undefined,
        description: a.description as string | undefined,
        preamble: a.preamble as string | undefined,
        createdAt: new Date().toISOString(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, message: `Profile '${profileName}' saved.` }) }],
      };
    }

    case "list_profiles": {
      logger.info("tool:list_profiles");
      const profiles = (await loadProfiles()).map(({ name, repoUrl, description, defaultBudgetUsd }) => ({
        name,
        repoUrl,
        description,
        defaultBudgetUsd,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ profiles, total: profiles.length }) }],
      };
    }

    case "delete_profile": {
      logger.info("tool:delete_profile", { name: a.name });
      const deleted = await deleteProfile(a.name as string);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              deleted
                ? { ok: true, message: `Profile '${a.name}' deleted.` }
                : { error: `Profile '${a.name}' not found.` }
            ),
          },
        ],
      };
    }

    case "spawn_from_profile": {
      logger.info("tool:spawn_from_profile", { profile_name: a.profile_name });
      const profile = await getProfile(a.profile_name as string);
      if (!profile) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Profile '${a.profile_name}' not found.` }) }],
        };
      }
      const vars = (a.vars ?? {}) as Record<string, string>;
      const task = a.task_override
        ? (a.task_override as string)
        : interpolate(profile.taskTemplate, vars);
      const jobId = await manager.spawn({
        repoUrl: profile.repoUrl,
        task,
        branch: (a.branch_override as string | undefined) ?? profile.branch,
        maxBudgetUsd: (a.budget_override as number | undefined) ?? profile.defaultBudgetUsd,
        preamble: profile.preamble,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ job_id: jobId, status: "started", profile: a.profile_name, message: "Agent spawned. Use get_job_output to follow progress." }),
          },
        ],
      };
    }

    case "create_plan": {
      logger.info("tool:create_plan", { goal: (a.goal as string)?.slice(0, 80) });
      const goal = a.goal as string;
      const steps = a.steps as Array<{
        id: string;
        repo_url: string;
        task: string;
        create_branch?: string;
        depends_on?: string[];
        branches?: number;
        branch_eval?: "test_pass_rate" | "pr_merged" | "manual";
        branch_select?: "best_score" | "score_prop" | "latest";
      }>;

      const stepIdToJobId = new Map<string, string>();
      const results: Array<{ stepId: string; jobId: string; status: string; role?: string }> = [];

      for (const step of steps) {
        const resolvedDeps = step.depends_on?.map((sid) => {
          const jobId = stepIdToJobId.get(sid);
          if (!jobId) throw new Error(`Step '${step.id}' depends_on unknown step '${sid}'`);
          return jobId;
        });

        if (step.branches && step.branches > 1) {
          // Evolutionary mode: spawn N variant jobs in parallel
          const branchEval = step.branch_eval ?? "test_pass_rate";
          const branchSelect = step.branch_select ?? "best_score";
          const variantJobIds: string[] = [];
          const variantBranches: (string | undefined)[] = [];

          for (let i = 1; i <= step.branches; i++) {
            const branchName = step.create_branch ? `${step.create_branch}-v${i}` : undefined;
            variantBranches.push(branchName);
            const jobId = await manager.spawn({
              repoUrl: normalizeRepoUrl(step.repo_url),
              task: step.task,
              createBranch: branchName,
              dependsOn: resolvedDeps,
              variantIndex: i,
            });
            variantJobIds.push(jobId);
          }

          // Update siblings on all variant jobs
          for (const jobId of variantJobIds) {
            manager.setJobSiblings(jobId, variantJobIds.filter((id) => id !== jobId));
          }

          // Build evaluator task and spawn evaluator job
          const evalTask = buildEvaluatorTask({
            variantJobIds,
            variantBranches,
            branchEval,
            branchSelect,
            stepId: step.id,
          });

          const evalJobId = await manager.spawn({
            repoUrl: normalizeRepoUrl(step.repo_url),
            task: evalTask,
            dependsOn: variantJobIds,
          });

          // The logical step ID maps to the evaluator job (so subsequent steps depend on it)
          stepIdToJobId.set(step.id, evalJobId);

          // Track variant jobs
          for (let i = 0; i < variantJobIds.length; i++) {
            results.push({
              stepId: `${step.id}-v${i + 1}`,
              jobId: variantJobIds[i],
              status: resolvedDeps?.length ? "pending" : "cloning",
              role: "variant",
            });
          }
          // Track evaluator job
          results.push({
            stepId: step.id,
            jobId: evalJobId,
            status: "pending",
            role: "evaluator",
          });
        } else {
          // Standard single job
          const jobId = await manager.spawn({
            repoUrl: normalizeRepoUrl(step.repo_url),
            task: step.task,
            createBranch: step.create_branch,
            dependsOn: resolvedDeps,
          });

          stepIdToJobId.set(step.id, jobId);
          results.push({ stepId: step.id, jobId, status: resolvedDeps?.length ? "pending" : "cloning" });
        }
      }

      const planId = uuidv4();
      planStore.savePlan({ id: planId, goal, steps: results, createdAt: new Date().toISOString() }).catch(() => {});

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              plan_id: planId,
              goal,
              totalSteps: steps.length,
              steps: results,
              message: "Plan created. Jobs with dependencies will start automatically when their dependencies complete.",
            }),
          },
        ],
      };
    }

    case "wake_job": {
      logger.info("tool:wake_job", { job_id: a.job_id });
      const result = await manager.wakeJob(a.job_id as string);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "list_model_ratings": {
      logger.info("tool:list_model_ratings");
      const ratingsFile = join(homedir(), ".cc-agent", "model-ratings.jsonl");
      let ratings: unknown[] = [];
      try {
        const content = await readFile(ratingsFile, "utf-8");
        ratings = content
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l));
      } catch {}
      return {
        content: [{ type: "text", text: JSON.stringify({ ratings, total: ratings.length }) }],
      };
    }

    case "get_logs": {
      logger.info("tool:get_logs", { lines: a.lines });
      const n = Math.min(typeof a.lines === "number" ? a.lines : 100, 500);
      const logFile = join(homedir(), ".cc-agent", "logs", "cc-agent.log");
      let lines: string[] = [];
      try {
        if (existsSync(logFile)) {
          const content = readFileSync(logFile, "utf-8");
          lines = content.split("\n").filter((l) => l.length > 0);
          lines = lines.slice(-n);
        }
      } catch {}
      return {
        content: [{ type: "text", text: JSON.stringify({ lines, total: lines.length }) }],
      };
    }

    case "list_project_issues": {
      logger.info("tool:list_project_issues", { repo: a.repo });
      const repo = a.repo as string;
      const state = (a.state as string | undefined) ?? "open";
      const labels = a.labels as string[] | undefined;
      const assignee = a.assignee as string | undefined;
      const ghArgs = ["issue", "list", "--repo", repo, "--state", state, "--json", "number,title,body,labels,assignees,createdAt,url"];
      if (labels?.length) {
        for (const label of labels) ghArgs.push("--label", label);
      }
      if (assignee) ghArgs.push("--assignee", assignee);
      try {
        const { stdout } = await execFileAsync("gh", ghArgs);
        const issues = JSON.parse(stdout.trim() || "[]");
        return { content: [{ type: "text", text: JSON.stringify({ issues, total: issues.length }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }] };
      }
    }

    case "work_on_issue": {
      logger.info("tool:work_on_issue", { repo: a.repo, issue_number: a.issue_number });
      const repo = a.repo as string;
      const issueNumber = a.issue_number as number;
      const extraContext = a.extra_context as string | undefined;
      const maxBudget = a.max_budget_usd as number | undefined;

      // Fetch issue details
      let issueData: { number: number; title: string; body: string; url: string; comments: unknown[] };
      try {
        const { stdout } = await execFileAsync("gh", ["issue", "view", String(issueNumber), "--repo", repo, "--json", "number,title,body,url,comments"]);
        issueData = JSON.parse(stdout.trim());
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to fetch issue: ${String(err)}` }) }] };
      }

      // Post pickup comment
      try {
        await execFileAsync("gh", ["issue", "comment", String(issueNumber), "--repo", repo, "--body", "🤖 cc-agent picking up this issue..."]);
      } catch {
        // Non-fatal
      }

      // Normalize repo to full URL
      const repoUrl = normalizeRepoUrl(repo.startsWith("http") ? repo : `https://github.com/${repo}`);

      // Build task
      const taskLines = [
        `You are working on GitHub issue #${issueNumber}: ${issueData.title}`,
        ``,
        `## Issue Description`,
        issueData.body ?? "(no description)",
      ];
      if (extraContext) {
        taskLines.push(``, `## Additional Context`, extraContext);
      }
      taskLines.push(
        ``,
        `## When Done`,
        `Close the issue with: gh issue close ${issueNumber} --repo ${repo} --comment "Fixed in <PR_URL>"`,
        ``,
        `## If Blocked`,
        `Comment on the issue: gh issue comment ${issueNumber} --repo ${repo} --body "..."`,
      );
      const task = taskLines.join("\n");

      const jobId = await manager.spawn({ repoUrl, task, maxBudgetUsd: maxBudget });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ job_id: jobId, issue_number: issueNumber, issue_url: issueData.url, agent_job_id: jobId }),
        }],
      };
    }

    case "comment_on_issue": {
      logger.info("tool:comment_on_issue", { repo: a.repo, issue_number: a.issue_number });
      const repo = a.repo as string;
      const issueNumber = a.issue_number as number;
      const body = a.body as string;
      try {
        await execFileAsync("gh", ["issue", "comment", String(issueNumber), "--repo", repo, "--body", body]);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, issue_number: issueNumber }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }] };
      }
    }

    case "close_issue": {
      logger.info("tool:close_issue", { repo: a.repo, issue_number: a.issue_number });
      const repo = a.repo as string;
      const issueNumber = a.issue_number as number;
      const comment = a.comment as string | undefined;
      const ghArgs = ["issue", "close", String(issueNumber), "--repo", repo];
      if (comment) ghArgs.push("--comment", comment);
      try {
        await execFileAsync("gh", ghArgs);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, issue_number: issueNumber }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }] };
      }
    }

    case "approve_job": {
      logger.info("tool:approve_job", { job_id: a.job_id });
      const result = await manager.approveJob(a.job_id as string);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "set_job_score": {
      logger.info("tool:set_job_score", { job_id: a.job_id, score: a.score });
      const result = manager.setJobScore(a.job_id as string, a.score as number, a.reason as string | undefined);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "get_learnings": {
      const repoParam = a.repo as string | undefined;
      const ns = repoParam ?? (a.namespace as string | undefined) ?? getNamespace();
      const limit = typeof a.limit === "number" ? a.limit : 10;
      logger.info("tool:get_learnings", { key: ns, limit });
      const learnings = await learningsStore.getLearnings(ns, limit);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ namespace: ns, learnings, total: learnings.length }),
        }],
      };
    }

    case "clear_learnings": {
      const ns = (a.namespace as string | undefined) ?? getNamespace();
      logger.info("tool:clear_learnings", { namespace: ns });
      await learningsStore.clearLearnings(ns);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true, namespace: ns, message: `Learnings cleared for namespace '${ns}'.` }),
        }],
      };
    }

    case "docker_ps": {
      logger.info("tool:docker_ps");
      const containers = await listCcAgentContainers();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ containers, total: containers.length }),
        }],
      };
    }

    case "list_token_status": {
      logger.info("tool:list_token_status");
      const tokens = loadTokens();
      const status = await getTokenStatus();
      const tokenList = tokens.map((t, i) => ({
        index: i,
        masked: t.length > 10 ? `${t.slice(0, 7)}...${t.slice(-3)}` : "***",
        status: i < status.index ? "exhausted" : i === status.index ? "active" : "pending",
      }));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            tokens: tokenList,
            current: status.index,
            total: status.total,
            allExhausted: status.allExhausted,
          }),
        }],
      };
    }

    case "list_crons": {
      logger.info("tool:list_crons");
      const crons = await cronEngine.listCrons();
      return { content: [{ type: "text", text: JSON.stringify({ crons, total: crons.length }) }] };
    }

    case "create_cron": {
      logger.info("tool:create_cron", { schedule: a.schedule });
      const cron = await cronEngine.addCron({
        chatId: typeof a.chat_id === "number" ? a.chat_id : 0,
        intervalMs: a.interval_ms as number,
        prompt: a.prompt as string,
        schedule: a.schedule as string,
        repoUrl: a.repo_url as string | undefined,
        enabled: typeof a.enabled === "boolean" ? a.enabled : true,
      });
      return { content: [{ type: "text", text: JSON.stringify(cron) }] };
    }

    case "delete_cron": {
      logger.info("tool:delete_cron", { cron_id: a.cron_id });
      const deleted = await cronEngine.deleteCron(a.cron_id as string);
      return { content: [{ type: "text", text: JSON.stringify({ deleted, cron_id: a.cron_id }) }] };
    }

    case "update_cron": {
      logger.info("tool:update_cron", { cron_id: a.cron_id });
      const updates: Record<string, unknown> = {};
      if (typeof a.interval_ms === "number") updates.intervalMs = a.interval_ms;
      if (typeof a.prompt === "string") updates.prompt = a.prompt;
      if (typeof a.schedule === "string") updates.schedule = a.schedule;
      if (typeof a.enabled === "boolean") updates.enabled = a.enabled;
      const updated = await cronEngine.updateCron(a.cron_id as string, updates as Parameters<typeof cronEngine.updateCron>[1]);
      return { content: [{ type: "text", text: JSON.stringify(updated ?? { error: "cron not found" }) }] };
    }

    case "list_notifications": {
      logger.info("tool:list_notifications");
      const ns = getNamespace();
      const redis = getRedis();
      let messages: string[] = [];
      if (redis) {
        messages = await redis.lrange(`cca:notify-log:${ns}`, 0, 19);
      }
      return { content: [{ type: "text", text: JSON.stringify({ messages, total: messages.length, namespace: ns }) }] };
    }

    case "list_active_repos": {
      logger.info("tool:list_active_repos");
      const redis = getRedis();
      if (!redis) return { content: [{ type: "text", text: "Redis unavailable" }] };

      const keys = await redis.keys("cca:jobs:*");
      const namespaces: Array<{
        namespace: string;
        total_jobs: number;
        active_jobs: number;
        recent_job_ids: string[];
        last_activity: string | null;
      }> = [];

      for (const key of keys) {
        if (key.includes(":index")) continue;
        const ns = key.replace("cca:jobs:", "");
        const jobIds = await redis.smembers(key);

        const pipeline = redis.pipeline();
        for (const id of jobIds) pipeline.get(`cca:job:${id}`);
        const results = await pipeline.exec();

        const jobs = (results ?? [])
          .map(([err, raw]) => {
            if (err || !raw) return null;
            try { return JSON.parse(raw as string) as { id: string; status: string; startedAt?: string }; } catch { return null; }
          })
          .filter((j): j is { id: string; status: string; startedAt?: string } => j !== null);

        const activeStatuses = new Set(["running", "cloning", "pending", "pending_approval"]);
        const activeJobs = jobs.filter((j) => activeStatuses.has(j.status));
        const lastJob = jobs.slice().sort(
          (a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime()
        )[0];

        namespaces.push({
          namespace: ns,
          total_jobs: jobs.length,
          active_jobs: activeJobs.length,
          recent_job_ids: activeJobs.map((j) => j.id).slice(0, 5),
          last_activity: lastJob?.startedAt ?? null,
        });
      }

      namespaces.sort((a, b) => b.active_jobs - a.active_jobs);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ namespaces }, null, 2),
        }],
      };
    }

    case "get_pubsub_status": {
      logger.info("tool:get_pubsub_status");
      const redis = getRedis();
      if (!redis) return { content: [{ type: "text", text: "Redis unavailable" }] };

      const channels = await redis.pubsub("CHANNELS", "cca:*") as string[];
      const numsub = channels.length > 0
        ? await redis.pubsub("NUMSUB", ...channels) as (string | number)[]
        : [];

      const channelCounts: Record<string, number> = {};
      for (let i = 0; i < numsub.length; i += 2) {
        channelCounts[numsub[i] as string] = Number(numsub[i + 1]);
      }

      const ns = getNamespace();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            active_channels: channelCounts,
            expected_channels: [
              `cca:notify:${ns}`,
              `cca:chat:incoming:${ns}`,
              `cca:chat:outgoing:${ns}`,
            ],
          }, null, 2),
        }],
      };
    }

    case "start_meta_agent": {
      logger.info("tool:start_meta_agent", { namespace: a.namespace });
      const ns = a.namespace as string;
      const repoUrl = a.repo_url as string | undefined;
      try {
        const info = await metaAgentManager.startMetaAgent(ns, repoUrl);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: true, ...info, message: `Meta-agent started. Responses published to cca:chat:outgoing:${ns}.` }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: false, error: String(err) }),
          }],
        };
      }
    }

    case "message_meta_agent": {
      logger.info("tool:message_meta_agent", { namespace: a.namespace });
      const ns = a.namespace as string;
      const message = a.message as string;
      try {
        await metaAgentManager.messageMetaAgent(ns, message);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: true, namespace: ns, message: "Message queued for delivery to meta-agent." }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: false, error: String(err) }),
          }],
        };
      }
    }

    case "list_meta_agents": {
      logger.info("tool:list_meta_agents");
      const agents = await metaAgentManager.listMetaAgents();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ agents, total: agents.length }),
        }],
      };
    }

    case "stop_meta_agent": {
      logger.info("tool:stop_meta_agent", { namespace: a.namespace });
      const ns = a.namespace as string;
      try {
        await metaAgentManager.stopMetaAgent(ns);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: true, namespace: ns, message: "Meta-agent stopped." }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: false, error: String(err) }),
          }],
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Top-level crash guards — log but never kill the process
process.on('uncaughtException', (err) => {
  logger.error('[cc-agent] uncaughtException — process will NOT exit', { err: String(err) });
});
process.on('unhandledRejection', (reason) => {
  logger.error('[cc-agent] unhandledRejection — process will NOT exit', { reason: String(reason) });
});

// Bootstrap: provision Redis, restore jobs, then start background engines
await initRedis();
const redis = getRedis();
if (redis) {
  await redis.set('cca:meta:cc-agent:version', PKG_VERSION);
  logger.info(`[cc-agent] version ${PKG_VERSION} written to Redis`);
}
await manager.init();
await coordinator.start();
await cronEngine.start();

const transport = new StdioServerTransport();
await server.connect(transport);
