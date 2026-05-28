/**
 * workflow.ts — dynamic workflow execution for cc-agent
 *
 * Decomposes a high-level goal into an ordered dependency DAG (stages) via
 * Anthropic Messages API (native fetch, zero new npm deps), then spawns all
 * jobs with proper stage-based dependsOn constraints so later stages only
 * start after all jobs in the prior stage complete.
 */

import { v4 as uuidv4 } from "uuid";
import type { Redis } from "ioredis";
import type { JobManager } from "./agent.js";
import { logger } from "./logger.js";
import type { WorkflowRecord, WorkflowStage, WorkflowStep } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const WORKFLOW_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const DECOMPOSE_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";

// Hard cap on stages per workflow
export const WORKFLOW_MAX_STAGES_HARD_CAP = 20;

// Redis key helper — cc-wire does not export a workflowKey so we define it here
const workflowRedisKey = (id: string) => `cca:workflow:${id}`;

// ─── In-memory fallback ───────────────────────────────────────────────────────

const memWorkflows = new Map<string, WorkflowRecord>();

// ─── Redis helpers ────────────────────────────────────────────────────────────

async function saveWorkflow(redis: Redis | null, record: WorkflowRecord): Promise<void> {
  if (redis) {
    try {
      await redis.set(
        workflowRedisKey(record.workflow_id),
        JSON.stringify(record),
        "EX",
        WORKFLOW_TTL_SECONDS,
      );
      return;
    } catch (err) {
      logger.error("workflow:save-failed", { workflow_id: record.workflow_id, err: String(err) });
    }
  }
  memWorkflows.set(record.workflow_id, record);
}

async function loadWorkflow(redis: Redis | null, workflowId: string): Promise<WorkflowRecord | null> {
  if (redis) {
    try {
      const raw = await redis.get(workflowRedisKey(workflowId));
      return raw ? (JSON.parse(raw) as WorkflowRecord) : null;
    } catch (err) {
      logger.error("workflow:load-failed", { workflow_id: workflowId, err: String(err) });
    }
  }
  return memWorkflows.get(workflowId) ?? null;
}

// ─── Decomposition ────────────────────────────────────────────────────────────

/**
 * Parse the text content from an Anthropic Messages API response and extract
 * the JSON array of stage objects. Exported for unit testing.
 */
export function parseWorkflowResponse(text: string): WorkflowStage[] {
  const cleaned = text.trim();

  // Strategy 1: entire text is valid JSON
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return validateStages(parsed);
  } catch { /* fall through */ }

  // Strategy 2: find first [...] block (handles markdown fences + prose)
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return validateStages(parsed);
    } catch { /* fall through */ }
  }

  // Strategy 3: find a JSON code fence block
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(parsed)) return validateStages(parsed);
    } catch { /* fall through */ }
  }

  throw new Error(`Cannot extract JSON array from workflow response: ${cleaned.slice(0, 500)}`);
}

/** Ensure every element has { stage: number, steps: [{id, task}] }. Exported for testing. */
export function validateStages(arr: unknown[]): WorkflowStage[] {
  return arr
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && "stage" in item && "steps" in item,
    )
    .map((item) => {
      const stageNum = Number(item.stage) || 0;
      const stepsRaw = Array.isArray(item.steps) ? item.steps : [];
      const steps: WorkflowStep[] = (
        stepsRaw as unknown[]
      )
        .filter(
          (s): s is Record<string, unknown> =>
            typeof s === "object" && s !== null && "task" in s,
        )
        .map((s, i) => ({
          id: String(s.id || `s${stageNum}-${i + 1}`),
          task: String(s.task || ""),
          depends_on: Array.isArray(s.depends_on) ? (s.depends_on as unknown[]).map(String) : undefined,
        }))
        .filter((s) => s.task.trim().length > 0);
      return { stage: stageNum, steps };
    })
    .filter((s) => s.steps.length > 0)
    .sort((a, b) => a.stage - b.stage);
}

/** Call Anthropic Messages API to decompose a goal into ordered stages. */
async function decomposeWorkflowGoal(
  goal: string,
  maxStages: number,
  maxAgentsPerStage: number,
): Promise<WorkflowStage[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const oauthToken =
    process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.CLAUDE_CODE_TOKEN;

  if (!apiKey && !oauthToken) {
    throw new Error(
      "Workflow decomposition requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN to be set",
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

  const prompt = buildWorkflowDecomposePrompt(goal, maxStages, maxAgentsPerStage);

  const body = JSON.stringify({
    model: DECOMPOSE_MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  logger.info("workflow:decompose-request", {
    model: DECOMPOSE_MODEL,
    goal: goal.slice(0, 120),
    max_stages: maxStages,
  });

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "(no body)");
    throw new Error(
      `Anthropic API error ${response.status}: ${errText.slice(0, 500)}`,
    );
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const textBlock = data.content?.find((b) => b.type === "text");
  if (!textBlock?.text) {
    throw new Error(
      "Anthropic API returned no text content in workflow decompose response",
    );
  }

  const stages = parseWorkflowResponse(textBlock.text);
  if (stages.length === 0) {
    throw new Error("Workflow decomposition returned 0 stages — cannot proceed");
  }

  logger.info("workflow:decomposed", {
    stage_count: stages.length,
    total_steps: stages.reduce((n, s) => n + s.steps.length, 0),
  });
  return stages;
}

function buildWorkflowDecomposePrompt(
  goal: string,
  maxStages: number,
  maxAgentsPerStage: number,
): string {
  return `You are a workflow decomposition assistant. Break the following goal into an ordered sequence of stages, where each stage can contain multiple parallel tasks. Tasks in later stages depend on all tasks in earlier stages completing first.

GOAL:
${goal}

Return ONLY a JSON array (no prose, no markdown fences) where each element represents a stage:
- "stage": stage number starting at 1
- "steps": array of parallel tasks within this stage, each with:
  - "id": a short unique slug (e.g. "s1-build", "s2-test", "s3-deploy")
  - "task": a clear, actionable description for a coding agent

Rules:
- Use at most ${maxStages} stages
- Use at most ${maxAgentsPerStage} parallel steps per stage
- Steps in the same stage run concurrently
- A later stage only starts after ALL steps in the previous stage complete
- Each step should be a self-contained unit of work for one coding agent

Example output:
[
  {"stage": 1, "steps": [{"id": "s1-setup", "task": "Set up project scaffolding and install dependencies"}]},
  {"stage": 2, "steps": [{"id": "s2-impl", "task": "Implement the core feature"}, {"id": "s2-tests", "task": "Write the test suite"}]},
  {"stage": 3, "steps": [{"id": "s3-deploy", "task": "Create deployment configuration and open a PR"}]}
]

Return at least 1 stage. Return no more than ${maxStages} stages with no more than ${maxAgentsPerStage} steps per stage.`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface RunWorkflowParams {
  repoUrl: string;
  goal: string;
  maxStages?: number;
  maxAgentsPerStage?: number;
  maxBudgetPerAgent?: number;
  agentModel?: string;
  agentDriver?: string;
  manager: JobManager;
  redis: Redis | null;
}

/**
 * Entry point called from index.ts.
 * Returns immediately with workflow_id, total_stages, total_jobs, job_ids.
 * Stage ordering is enforced via dependsOn job IDs from the prior stage.
 */
export async function runWorkflow(params: RunWorkflowParams): Promise<{
  workflow_id: string;
  total_stages: number;
  total_jobs: number;
  job_ids: string[];
  stages: WorkflowStage[];
}> {
  const {
    repoUrl,
    goal,
    maxStages = 8,
    maxAgentsPerStage = 3,
    maxBudgetPerAgent = 5,
    agentModel,
    agentDriver,
    manager,
    redis,
  } = params;

  const effectiveMaxStages = Math.min(maxStages, WORKFLOW_MAX_STAGES_HARD_CAP);

  let stages: WorkflowStage[];
  try {
    stages = await decomposeWorkflowGoal(goal, effectiveMaxStages, maxAgentsPerStage);
  } catch (err) {
    throw new Error(`Workflow decomposition failed: ${String(err)}`);
  }

  const workflowId = uuidv4();
  const allJobIds: string[] = [];
  let priorStageJobIds: string[] = [];

  for (const stageEntry of stages) {
    const currentStageJobIds: string[] = [];

    for (const step of stageEntry.steps) {
      try {
        const jobId = await manager.spawn({
          repoUrl,
          task: step.task,
          dependsOn: priorStageJobIds.length > 0 ? [...priorStageJobIds] : undefined,
          maxBudgetUsd: maxBudgetPerAgent,
          agentModel,
          agentDriver,
          noPreamble: false,
        });
        step.job_id = jobId;
        currentStageJobIds.push(jobId);
        allJobIds.push(jobId);
      } catch (err) {
        logger.error("workflow:step-spawn-failed", {
          workflow_id: workflowId,
          stage: stageEntry.stage,
          step_id: step.id,
          err: String(err),
        });
        // Continue spawning remaining steps even if one fails
      }
    }

    priorStageJobIds = currentStageJobIds;
  }

  if (allJobIds.length === 0) {
    throw new Error("All workflow step spawns failed — cannot proceed");
  }

  const record: WorkflowRecord = {
    workflow_id: workflowId,
    goal,
    repo_url: repoUrl,
    stages,
    all_job_ids: allJobIds,
    status: "running",
    created_at: new Date().toISOString(),
  };
  await saveWorkflow(redis, record);

  logger.info("workflow:started", {
    workflow_id: workflowId,
    total_stages: stages.length,
    total_jobs: allJobIds.length,
    goal: goal.slice(0, 120),
  });

  return {
    workflow_id: workflowId,
    total_stages: stages.length,
    total_jobs: allJobIds.length,
    job_ids: allJobIds,
    stages,
  };
}

/** Status polling — called by get_workflow_status MCP tool. */
export async function getWorkflowStatus(
  workflowId: string,
  redis: Redis | null,
): Promise<WorkflowRecord | null> {
  return loadWorkflow(redis, workflowId);
}
