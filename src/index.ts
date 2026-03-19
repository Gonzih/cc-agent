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
        "Clone a git repo and run Claude Code on a task inside it. Returns a job_id immediately — the agent runs in the background.",
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Git repository URL to clone (https or ssh)",
          },
          task: {
            type: "string",
            description: "Task description to pass to Claude Code",
          },
          branch: {
            type: "string",
            description: "Branch to checkout after cloning (optional)",
          },
          create_branch: {
            type: "string",
            description: "New branch name to create before running the task (optional)",
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
      name: "get_version",
      description: "Returns the running cc-agent MCP server version.",
      inputSchema: { type: "object", properties: {} },
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
            }),
          },
        ],
      };
    }

    case "get_job_output": {
      const offset = typeof a.offset === "number" ? a.offset : 0;
      const { lines, done, toolCalls } = manager.getOutput(a.job_id as string, offset);
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

    case "get_version":
      return {
        content: [{ type: "text", text: JSON.stringify({ version: PKG_VERSION }) }],
      };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
