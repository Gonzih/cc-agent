/**
 * swarm.ts — swarm execution for cc-agent
 *
 * Decomposes a high-level goal into N sub-tasks via Anthropic Messages API
 * (native fetch, zero new npm deps), fans out parallel agents, waits for
 * all to complete, then spawns a synthesis agent that writes one deliverable.
 */

import { v4 as uuidv4 } from "uuid";
import type { Redis } from "ioredis";
import type { JobManager } from "./agent.js";
import { logger } from "./logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SWARM_TTL_SECONDS = 7 * 24 * 60 * 60;
const DECOMPOSE_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled", "rejected", "interrupted"]);

// Hard cap on agents per swarm
export const SWARM_MAX_AGENTS_HARD_CAP = 50;

// Polling interval for waitForAllSubJobs background loop
const POLL_INTERVAL_MS = 5000;

// Per-sub-job output limits for synthesis prompt
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_CHARS = 20_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type SwarmStatus = "running_subs" | "synthesizing" | "done" | "failed";

export interface SwarmRecord {
  swarm_id: string;
  goal: string;
  repo_url: string;
  sub_job_ids: string[];
  decomposed_tasks: Array<{ id: string; task: string }>;
  synthesis_job_id?: string;
  synthesis_output: string;
  status: SwarmStatus;
  created_at: string;
  completed_at?: string;
  error?: string;
}

export interface RunSwarmParams {
  repoUrl: string;
  goal: string;
  maxAgents?: number;
  synthesisOutput?: string;
  synthesisPrompt?: string;
  maxBudgetPerAgent?: number;
  agentModel?: string;
  agentDriver?: string;
  manager: JobManager;
  redis: Redis | null;
  getJobOutput: (id: string, offset: number) => Promise<string[]>;
}

// ─── Redis helpers ────────────────────────────────────────────────────────────

/** In-memory fallback map when Redis is unavailable. */
const memSwarms = new Map<string, SwarmRecord>();

async function saveSwarm(redis: Redis | null, record: SwarmRecord): Promise<void> {
  if (redis) {
    try {
      await redis.set(`cca:swarm:${record.swarm_id}`, JSON.stringify(record), "EX", SWARM_TTL_SECONDS);
      return;
    } catch (err) {
      logger.error("swarm:save-failed", { swarm_id: record.swarm_id, err: String(err) });
    }
  }
  memSwarms.set(record.swarm_id, record);
}

async function loadSwarm(redis: Redis | null, swarmId: string): Promise<SwarmRecord | null> {
  if (redis) {
    try {
      const raw = await redis.get(`cca:swarm:${swarmId}`);
      return raw ? (JSON.parse(raw) as SwarmRecord) : null;
    } catch (err) {
      logger.error("swarm:load-failed", { swarm_id: swarmId, err: String(err) });
    }
  }
  return memSwarms.get(swarmId) ?? null;
}

// ─── Decomposition ────────────────────────────────────────────────────────────

/**
 * Parse the text content from an Anthropic Messages API response and extract
 * the JSON array of subtask objects. Exported for unit testing.
 */
export function parseDecomposeResponse(text: string): Array<{ id: string; task: string }> {
  // Try to extract a JSON array from the text (may be surrounded by markdown fences or prose)
  const cleaned = text.trim();

  // Strategy 1: entire text is valid JSON
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return validateTasks(parsed);
  } catch { /* fall through */ }

  // Strategy 2: find first [...] block (handles markdown fences + prose)
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return validateTasks(parsed);
    } catch { /* fall through */ }
  }

  // Strategy 3: find a JSON code fence block
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(parsed)) return validateTasks(parsed);
    } catch { /* fall through */ }
  }

  throw new Error(`Cannot extract JSON array from decompose response: ${cleaned.slice(0, 500)}`);
}

/** Ensure every element has { id: string, task: string }. Missing id is auto-generated. */
function validateTasks(arr: unknown[]): Array<{ id: string; task: string }> {
  return arr
    .filter((item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && "task" in item
    )
    .map((item, i) => ({
      id: String((item.id as unknown) || `task-${i + 1}`),
      task: String((item.task as unknown) || ""),
    }))
    .filter((item) => item.task.trim().length > 0);
}

/** Call Anthropic Messages API to decompose a goal into N subtasks. */
async function decomposeGoal(
  goal: string,
  maxAgents: number,
): Promise<Array<{ id: string; task: string }>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const oauthToken =
    process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.CLAUDE_CODE_TOKEN;

  if (!apiKey && !oauthToken) {
    throw new Error(
      "Decomposition requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN to be set"
    );
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_API_VERSION,
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  } else {
    headers["authorization"] = `Bearer ${oauthToken!}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  }

  const prompt = buildDecomposePrompt(goal, maxAgents);

  const body = JSON.stringify({
    model: DECOMPOSE_MODEL,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  logger.info("swarm:decompose-request", { model: DECOMPOSE_MODEL, goal: goal.slice(0, 120) });

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "(no body)");
    throw new Error(
      `Anthropic API error ${response.status}: ${errText.slice(0, 500)}`
    );
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const textBlock = data.content?.find((b) => b.type === "text");
  if (!textBlock?.text) {
    throw new Error("Anthropic API returned no text content in decompose response");
  }

  const tasks = parseDecomposeResponse(textBlock.text);
  if (tasks.length === 0) {
    throw new Error("Decomposition returned 0 tasks — cannot proceed");
  }

  logger.info("swarm:decomposed", { task_count: tasks.length });
  return tasks;
}

function buildDecomposePrompt(goal: string, maxAgents: number): string {
  return `You are a task decomposition assistant. Break the following goal into at most ${maxAgents} parallel, independent sub-tasks that can be executed simultaneously by separate coding agents. Each sub-task should be a self-contained unit of work.

GOAL:
${goal}

Return ONLY a JSON array (no prose, no markdown fences) where each element has:
- "id": a short slug (e.g. "task-1", "task-2")
- "task": a clear, actionable description for that sub-task

Example output:
[
  {"id": "task-1", "task": "..."},
  {"id": "task-2", "task": "..."}
]

Return no more than ${maxAgents} tasks. Return at least 1 task.`;
}

// ─── Synthesis ────────────────────────────────────────────────────────────────

/**
 * Build the synthesis agent task string. Exported for unit testing.
 *
 * The synthesis agent receives: goal, all N sub-job outputs labelled by
 * sub-task description, and an instruction to write the result to
 * synthesisOutput and open a PR. No MCP tools needed — all data is inline.
 */
export function buildSynthesisTask(
  goal: string,
  tasks: Array<{ id: string; task: string }>,
  outputs: Array<{ taskId: string; task: string; status: string; lines: string[] }>,
  synthesisOutput: string,
  synthesisPrompt?: string,
): string {
  const outputSections = outputs
    .map((o) => {
      const truncated = truncateOutput(o.lines);
      return `### Sub-task: ${o.task}
Status: ${o.status}
Output (${o.lines.length} total lines${truncated.length < o.lines.length ? `, showing last ${truncated.length}` : ""}):
\`\`\`
${truncated.join("\n")}
\`\`\``;
    })
    .join("\n\n");

  const instruction =
    synthesisPrompt ??
    `Review all sub-task outputs above, synthesize the findings, and produce a unified deliverable. Write the final synthesis report to \`${synthesisOutput}\` in the repository and open a Pull Request with your result.`;

  return `# Swarm Synthesis Task

## Original Goal
${goal}

## Sub-task Outputs (${outputs.length} sub-tasks)

${outputSections}

## Instructions
${instruction}

Write the synthesized result to \`${synthesisOutput}\` in this repository and open a Pull Request titled "swarm synthesis: ${goal.slice(0, 60)}".`;
}

function truncateOutput(lines: string[]): string[] {
  const tail = lines.slice(-MAX_OUTPUT_LINES);
  const joined = tail.join("\n");
  if (joined.length <= MAX_OUTPUT_CHARS) return tail;
  // Char-limit: take last MAX_OUTPUT_CHARS characters, split by newline
  const chars = joined.slice(-MAX_OUTPUT_CHARS);
  const newlineIdx = chars.indexOf("\n");
  return (newlineIdx > 0 ? chars.slice(newlineIdx + 1) : chars).split("\n");
}

// ─── Background fan-in + synthesis ────────────────────────────────────────────

async function waitForAllSubJobs(
  swarmId: string,
  record: SwarmRecord,
  tasks: Array<{ id: string; task: string }>,
  synthesisPrompt: string | undefined,
  manager: JobManager,
  redis: Redis | null,
  getJobOutput: (id: string, offset: number) => Promise<string[]>,
  maxBudgetPerAgent: number,
  agentModel: string | undefined,
  agentDriver: string | undefined,
): Promise<void> {
  const { sub_job_ids: subJobIds, goal, repo_url: repoUrl, synthesis_output: synthesisOutput } = record;

  logger.info("swarm:waiting", { swarm_id: swarmId, sub_count: subJobIds.length });

  // Wait for all sub-jobs to reach terminal state
  const TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6-hour hard cap
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    let allDone = true;
    for (const jobId of subJobIds) {
      const rec = await fetchJobRecord(jobId, redis);
      if (!rec || !TERMINAL_STATUSES.has(rec.status)) {
        allDone = false;
        break;
      }
    }
    if (allDone) break;
    await sleep(POLL_INTERVAL_MS);
  }

  // Collect outputs for all sub-jobs
  const outputs: Array<{ taskId: string; task: string; status: string; lines: string[] }> = [];
  let totalCost = 0;

  for (let i = 0; i < subJobIds.length; i++) {
    const jobId = subJobIds[i];
    const taskEntry = tasks[i] ?? { id: `task-${i + 1}`, task: "(unknown)" };
    const rec = await fetchJobRecord(jobId, redis);
    const status = rec?.status ?? "unknown";
    if (rec?.costUsd) totalCost += rec.costUsd;

    let lines: string[] = [];
    try {
      lines = await getJobOutput(jobId, 0);
    } catch (err) {
      logger.warn("swarm:get-output-failed", { swarm_id: swarmId, job_id: jobId, err: String(err) });
      lines = [`[error reading output: ${String(err)}]`];
    }

    outputs.push({ taskId: taskEntry.id, task: taskEntry.task, status, lines });
  }

  logger.info("swarm:all-subs-done", {
    swarm_id: swarmId,
    total_cost_usd: totalCost,
    done: outputs.filter((o) => o.status === "done").length,
    failed: outputs.filter((o) => o.status !== "done").length,
  });

  // Build synthesis task
  const synthesisTask = buildSynthesisTask(goal, tasks, outputs, synthesisOutput, synthesisPrompt);

  // Update swarm to synthesizing
  record.status = "synthesizing";
  await saveSwarm(redis, record);

  // Spawn synthesis agent
  let synthesisJobId: string | undefined;
  try {
    synthesisJobId = await manager.spawn({
      repoUrl,
      task: synthesisTask,
      maxBudgetUsd: maxBudgetPerAgent,
      agentModel,
      agentDriver,
      noPreamble: false,
    });
    logger.info("swarm:synthesis-spawned", { swarm_id: swarmId, synthesis_job_id: synthesisJobId });
  } catch (err) {
    logger.error("swarm:synthesis-spawn-failed", { swarm_id: swarmId, err: String(err) });
    record.status = "failed";
    record.error = `Synthesis spawn failed: ${String(err)}`;
    record.completed_at = new Date().toISOString();
    await saveSwarm(redis, record);
    return;
  }

  record.synthesis_job_id = synthesisJobId;
  await saveSwarm(redis, record);

  // Wait for synthesis job to complete
  const synthDeadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < synthDeadline) {
    const rec = await fetchJobRecord(synthesisJobId, redis);
    if (rec && TERMINAL_STATUSES.has(rec.status)) {
      record.status = rec.status === "done" ? "done" : "failed";
      if (rec.status !== "done") {
        record.error = `Synthesis job ${synthesisJobId} ended with status: ${rec.status}`;
      }
      record.completed_at = new Date().toISOString();
      await saveSwarm(redis, record);
      logger.info("swarm:synthesis-done", { swarm_id: swarmId, synthesis_status: rec.status });
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Synthesis timed out
  record.status = "failed";
  record.error = "Synthesis job timed out (6h)";
  record.completed_at = new Date().toISOString();
  await saveSwarm(redis, record);
  logger.warn("swarm:synthesis-timeout", { swarm_id: swarmId });
}

/** Fetch a job record from Redis or return null. */
async function fetchJobRecord(
  jobId: string,
  redis: Redis | null,
): Promise<{ status: string; costUsd?: number } | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(`cca:job:${jobId}`);
    if (!raw) return null;
    return JSON.parse(raw) as { status: string; costUsd?: number };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Entry point called from index.ts.
 * Returns immediately (< 5s) with swarm_id + sub_job_ids.
 * Background async handles fan-in + synthesis.
 */
export async function runSwarm(params: RunSwarmParams): Promise<{
  swarm_id: string;
  sub_job_ids: string[];
  decomposed_tasks: Array<{ id: string; task: string }>;
  status: "running";
}> {
  const {
    repoUrl,
    goal,
    maxAgents = 10,
    synthesisOutput = "swarm-synthesis.md",
    synthesisPrompt,
    maxBudgetPerAgent = 5,
    agentModel,
    agentDriver,
    manager,
    redis,
    getJobOutput,
  } = params;

  // Validate hard cap
  const effectiveMax = Math.min(maxAgents, SWARM_MAX_AGENTS_HARD_CAP);

  // Decompose goal (fast — uses haiku model)
  let tasks: Array<{ id: string; task: string }>;
  try {
    tasks = await decomposeGoal(goal, effectiveMax);
  } catch (err) {
    throw new Error(`Swarm decomposition failed: ${String(err)}`);
  }

  const swarmId = uuidv4();

  // Spawn all sub-agents in parallel
  const subJobIds: string[] = [];
  for (const taskEntry of tasks) {
    try {
      const jobId = await manager.spawn({
        repoUrl,
        task: taskEntry.task,
        maxBudgetUsd: maxBudgetPerAgent,
        agentModel,
        agentDriver,
        noPreamble: false,
      });
      subJobIds.push(jobId);
    } catch (err) {
      logger.error("swarm:sub-spawn-failed", {
        swarm_id: swarmId,
        task_id: taskEntry.id,
        err: String(err),
      });
      // Continue spawning other agents even if one fails
    }
  }

  if (subJobIds.length === 0) {
    throw new Error("All sub-agent spawns failed — cannot proceed with swarm");
  }

  // Build and persist swarm record
  const record: SwarmRecord = {
    swarm_id: swarmId,
    goal,
    repo_url: repoUrl,
    sub_job_ids: subJobIds,
    decomposed_tasks: tasks,
    synthesis_output: synthesisOutput,
    status: "running_subs",
    created_at: new Date().toISOString(),
  };
  await saveSwarm(redis, record);

  logger.info("swarm:started", {
    swarm_id: swarmId,
    sub_count: subJobIds.length,
    goal: goal.slice(0, 120),
  });

  // Fire-and-forget background fan-in + synthesis
  waitForAllSubJobs(
    swarmId,
    record,
    tasks,
    synthesisPrompt,
    manager,
    redis,
    getJobOutput,
    maxBudgetPerAgent,
    agentModel,
    agentDriver,
  ).catch((err) => {
    logger.error("swarm:background-failed", { swarm_id: swarmId, err: String(err) });
    // Best-effort: try to mark swarm as failed
    loadSwarm(redis, swarmId)
      .then((r) => {
        if (r && r.status !== "done") {
          r.status = "failed";
          r.error = `Background error: ${String(err)}`;
          r.completed_at = new Date().toISOString();
          return saveSwarm(redis, r);
        }
      })
      .catch(() => {});
  });

  return {
    swarm_id: swarmId,
    sub_job_ids: subJobIds,
    decomposed_tasks: tasks,
    status: "running",
  };
}

/** Status polling — called by get_swarm_status MCP tool. */
export async function getSwarmStatus(
  swarmId: string,
  redis: Redis | null,
): Promise<SwarmRecord | null> {
  return loadSwarm(redis, swarmId);
}
