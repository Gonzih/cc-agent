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
import { JobManager } from "./agent.js";
import { loadProfiles, upsertProfile, deleteProfile, getProfile, interpolate } from "./profiles.js";
import { planStore, jobStore } from "./store.js";
import { initRedis } from "./redis.js";
import { logger } from "./logger.js";
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
      inputSchema: { type: "object", properties: {} },
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;

  switch (name) {
    case "spawn_agent": {
      const repoUrl = a.repo_url as string;
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
        requiresApproval: !isTrusted,
      });

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
      const jobs = (await jobStore.listJobs()) ?? [];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ jobs, total: jobs.length }),
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
      const result = manager.sendMessage(a.job_id as string, a.message as string);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.ok
              ? { job_id: a.job_id, sent: true, message: "Message delivered to agent stdin." }
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
        repoUrl: a.repo_url as string,
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
      }>;

      const stepIdToJobId = new Map<string, string>();
      const results: Array<{ stepId: string; jobId: string; status: string }> = [];

      for (const step of steps) {
        const resolvedDeps = step.depends_on?.map((sid) => {
          const jobId = stepIdToJobId.get(sid);
          if (!jobId) throw new Error(`Step '${step.id}' depends_on unknown step '${sid}'`);
          return jobId;
        });

        const jobId = await manager.spawn({
          repoUrl: step.repo_url,
          task: step.task,
          createBranch: step.create_branch,
          dependsOn: resolvedDeps,
        });

        stepIdToJobId.set(step.id, jobId);
        results.push({ stepId: step.id, jobId, status: resolvedDeps?.length ? "pending" : "cloning" });
      }

      // Persist the plan record
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
      const ghArgs = ["issue", "list", "--repo", repo, "--state", state, "--json", "number,title,body,labels,assignee,createdAt,url"];
      if (labels?.length) {
        for (const label of labels) ghArgs.push("--label", label);
      }
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
      const repoUrl = repo.startsWith("http") ? repo : `https://github.com/${repo}`;

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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Bootstrap: provision Redis, restore jobs, then start MCP transport
await initRedis();
await manager.init();

const transport = new StdioServerTransport();
await server.connect(transport);
