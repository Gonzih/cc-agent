/**
 * Coordinator — reads from the Redis Stream and:
 *   - Spawns onComplete / coordinator_plan follow-up jobs on done events
 *   - Publishes failure / low-score notifications to cca:notify:<namespace>
 *
 * Uses XREADGROUP with consumer group "coordinator" for reliable delivery.
 * MKSTREAM ensures the stream exists before any producers write to it.
 */

import type { JobManager } from "./agent.js";
import type { CoordinatorPlan, JobEvent } from "./types.js";
import { getRedis } from "./redis.js";
import { logger } from "./logger.js";

const STREAM_KEY = "cca:event-stream";
const COORDINATOR_GROUP = "coordinator";
const COORDINATOR_POLL_MS = 2000;
const LOW_SCORE_THRESHOLD = 0.5;

/** Publish to both pub/sub channel (live) and a capped LIST (queryable). */
export async function notify(namespace: string, text: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  // Protocol: NotificationPayload must be JSON { text, driver?, model?, cost? }
  const payload = JSON.stringify({ text });
  try {
    await redis.publish(`cca:notify:${namespace}`, payload);
    await redis.lpush(`cca:notify-log:${namespace}`, payload);
    await redis.ltrim(`cca:notify-log:${namespace}`, 0, 99);
  } catch (err) {
    logger.warn("coordinator:notify-failed", { namespace, err: String(err) });
  }
}

export class Coordinator {
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private manager: JobManager, private namespace: string) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info("coordinator:start", { namespace: this.namespace });

    // Create consumer group with MKSTREAM (idempotent — BUSYGROUP means already exists)
    const redis = getRedis();
    if (redis) {
      try {
        await redis.xgroup("CREATE", STREAM_KEY, COORDINATOR_GROUP, "0", "MKSTREAM");
      } catch (err) {
        if (!String(err).includes("BUSYGROUP")) {
          logger.warn("coordinator:xgroup-create-failed", { err: String(err) });
        }
      }
    }

    await this.replayMissedEvents();
    this.schedulePoll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info("coordinator:stop", { namespace: this.namespace });
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      this.poll()
        .catch((err) => logger.warn("coordinator:poll-error", { err: String(err) }))
        .finally(() => this.schedulePoll());
    }, COORDINATOR_POLL_MS);
    if (this.pollTimer && typeof (this.pollTimer as NodeJS.Timeout).unref === "function") {
      (this.pollTimer as NodeJS.Timeout).unref();
    }
  }

  private async poll(): Promise<void> {
    const redis = getRedis();
    if (!redis) return;

    let entries: [string, string[]][];
    try {
      // XREADGROUP reads new (undelivered) messages via '>'
      const raw = await redis.xreadgroup(
        "GROUP", COORDINATOR_GROUP, this.namespace,
        "COUNT", "100",
        "STREAMS", STREAM_KEY, ">"
      );
      if (!raw || (raw as unknown[]).length === 0) return;
      entries = ((raw as unknown as [string, [string, string[]][]][]) [0][1]);
    } catch (err) {
      logger.warn("coordinator:xreadgroup-failed", { err: String(err) });
      return;
    }

    for (const [entryId, fields] of entries) {
      try {
        const event = parseStreamEntry(fields);
        await this.processEvent(event);
        // ACK the message after successful processing
        await redis.xack(STREAM_KEY, COORDINATOR_GROUP, entryId);
      } catch (err) {
        logger.warn("coordinator:process-event-error", { entryId, err: String(err) });
        // Do not ACK on error — message stays in PEL for re-delivery on next restart
      }
    }
  }

  private async replayMissedEvents(): Promise<void> {
    // Read pending (delivered but unACKed) messages from before any crash
    const redis = getRedis();
    if (!redis) return;
    try {
      const raw = await redis.xreadgroup(
        "GROUP", COORDINATOR_GROUP, this.namespace,
        "COUNT", "100",
        "STREAMS", STREAM_KEY, "0"
      );
      if (!raw || (raw as unknown[]).length === 0) return;
      const entries = ((raw as unknown as [string, [string, string[]][]][]) [0][1]);
      for (const [entryId, fields] of entries) {
        // Empty fields array means the entry was deleted from the stream
        if (!fields || fields.length === 0) continue;
        try {
          const event = parseStreamEntry(fields);
          await this.processEvent(event);
          await redis.xack(STREAM_KEY, COORDINATOR_GROUP, entryId);
        } catch (err) {
          logger.warn("coordinator:replay-event-error", { entryId, err: String(err) });
        }
      }
    } catch (err) {
      logger.warn("coordinator:replay-failed", { err: String(err) });
    }
  }

  async processEvent(event: JobEvent): Promise<void> {
    const { jobId, status, title, repoUrl, score, coordinatorPlan } = event;

    if (status === "done") {
      // 1. Coordinator plan — spawn follow-up job if configured
      if (coordinatorPlan?.next_step) {
        await this.spawnNext(jobId, title, repoUrl, coordinatorPlan);
      }
    }

    if (status === "done" || status === "failed") {
      const icon = status === "done" ? "✅" : "❌";
      const scoreStr = typeof score === "number" ? ` (score: ${score.toFixed(2)})` : "";
      await notify(this.namespace, `${icon} ${title}${scoreStr} (job_id: ${jobId})\n${repoUrl}`);
    }
  }

  private async spawnNext(
    parentJobId: string,
    parentTitle: string,
    parentRepoUrl: string,
    plan: CoordinatorPlan,
  ): Promise<void> {
    const next = plan.next_step!;
    try {
      const childId = await this.manager.spawn({
        repoUrl: next.repo_url,
        task: next.task,
      });
      logger.info("[coordinator] job done → spawning next", {
        parentJobId,
        childId,
        nextRepo: next.repo_url,
      });
    } catch (err) {
      logger.warn("coordinator:spawn-next-failed", {
        parentJobId,
        err: String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse Redis Stream flat field array into a JobEvent. */
function parseStreamEntry(fields: string[]): JobEvent {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length - 1; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return {
    jobId: obj.jobId ?? "",
    status: obj.status ?? "",
    title: obj.title ?? "",
    repoUrl: obj.repoUrl ?? "",
    lastLines: obj.lastLines ? (JSON.parse(obj.lastLines) as string[]) : [],
    score: obj.score ? parseFloat(obj.score) : undefined,
    // Protocol: timestamp is ISO 8601 string
    timestamp: obj.timestamp ?? new Date().toISOString(),
    coordinatorPlan: obj.coordinatorPlan
      ? (JSON.parse(obj.coordinatorPlan) as CoordinatorPlan | null) ?? undefined
      : undefined,
  };
}
