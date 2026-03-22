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
import { planStore } from "./store.js";
import { initRedis } from "./redis.js";
import { v4 as uuidv4 } from "uuid";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json") as { version: string };

const token =
  process.env.CLAUDE_CODE_TOKEN ??
  process.env.CLAUDE_CODE_OAUTH_TOKEN ??
  process.env.ANTHROPIC_API_KEY;

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
      const jobId = await manager.spawn({
        repoUrl: a.repo_url as string,
        task: a.task as string,
        branch: a.branch as string | undefined,
        createBranch: a.create_branch as string | undefined,
        claudeToken: a.claude_token as string | undefined,
        continueSession: a.continue_session as boolean | undefined,
        maxBudgetUsd: a.max_budget_usd as number | undefined,
        sessionId: a.session_id as string | undefined,
        dependsOn: a.depends_on as string[] | undefined,
      });
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
            }),
          },
        ],
      };
    }

    case "get_job_output": {
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
      const jobs = manager.list();
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
      const jobs = manager.list();
      const totalCostUsd = jobs.reduce((sum, j) => sum + (j.costUsd ?? 0), 0);
      const byRepo: Record<string, number> = {};
      for (const j of jobs) {
        if (j.costUsd) {
          byRepo[j.repoUrl] = Math.round(((byRepo[j.repoUrl] ?? 0) + j.costUsd) * 10000) / 10000;
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              totalJobs: jobs.length,
              totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
              byRepo,
            }),
          },
        ],
      };
    }

    case "get_version":
      return {
        content: [{ type: "text", text: JSON.stringify({ version: PKG_VERSION }) }],
      };

    case "create_profile": {
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Bootstrap: provision Redis, restore jobs, then start MCP transport
await initRedis();
await manager.init();

const transport = new StdioServerTransport();
await server.connect(transport);
