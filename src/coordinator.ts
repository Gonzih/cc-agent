/**
 * Coordinator — reads from the Redis Stream and:
 *   - Spawns onComplete / coordinator_plan follow-up jobs on done events
 *   - Publishes failure / low-score notifications to cca:notify:<namespace>
 *
 * Restart-safe: tracks last-seen stream ID in cca:coordinator:last-id:<namespace>
 */

import type { JobManager } from "./agent.js";
import type { CoordinatorPlan, JobEvent } from "./types.js";
import { getRedis } from "./redis.js";
import { logger } from "./logger.js";

const STREAM_KEY = "cca:event-stream";
const POLL_INTERVAL_MS = 2000;
const LOW_SCORE_THRESHOLD = 0.5;

/** Publish to both pub/sub channel (live) and a capped LIST (queryable). */
export async function notify(namespace: string, message: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.publish(`cca:notify:${namespace}`, message);
    await redis.lpush(`cca:notify-log:${namespace}`, message);
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
    }, POLL_INTERVAL_MS);
    if (this.pollTimer && typeof (this.pollTimer as NodeJS.Timeout).unref === "function") {
      (this.pollTimer as NodeJS.Timeout).unref();
    }
  }

  private async poll(): Promise<void> {
    const redis = getRedis();
    if (!redis) return;

    const lastIdKey = `cca:coordinator:last-id:${this.namespace}`;
    const lastId = (await redis.get(lastIdKey)) ?? "0-0";

    let entries: [string, string[]][];
    try {
      // XREAD COUNT 100 BLOCK 0 STREAMS cca:event-stream <lastId>
      const raw = await redis.xread("COUNT", "100", "STREAMS", STREAM_KEY, lastId);
      if (!raw || raw.length === 0) return;
      // raw = [[streamKey, [[id, fields], ...]]]
      entries = (raw[0][1] as [string, string[]][]);
    } catch (err) {
      logger.warn("coordinator:xread-failed", { err: String(err) });
      return;
    }

    for (const [entryId, fields] of entries) {
      try {
        const event = parseStreamEntry(fields);
        await this.processEvent(event);
      } catch (err) {
        logger.warn("coordinator:process-event-error", { entryId, err: String(err) });
      }
      // Always advance cursor even if processing failed
      try {
        await redis.set(lastIdKey, entryId);
      } catch (err) {
        logger.warn("coordinator:cursor-update-failed", { err: String(err) });
      }
    }
  }

  private async replayMissedEvents(): Promise<void> {
    // Just run the normal poll from last saved ID (or 0-0 on first start).
    // This naturally replays any events written while the process was down.
    await this.poll();
  }

  async processEvent(event: JobEvent): Promise<void> {
    const { jobId, status, title, repoUrl, score, coordinatorPlan } = event;

    if (status === "done") {
      // 1. Coordinator plan from Redis (set by spawn_agent via coordinator_plan param)
      if (coordinatorPlan?.next_step) {
        await this.spawnNext(jobId, title, repoUrl, coordinatorPlan);
        return;
      }

      // 2. Low-score notification
      if (typeof score === "number" && score < LOW_SCORE_THRESHOLD) {
        await notify(
          this.namespace,
          `⚠ ${title} low score (${score.toFixed(2)})\n${repoUrl}`,
        );
      }
    }

    if (status === "failed") {
      await notify(
        this.namespace,
        `✗ ${title} failed\n${repoUrl}`,
      );
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
      await notify(
        this.namespace,
        `✓ ${parentTitle} done → spawned: ${next.repo_url}`,
      );
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
    timestamp: obj.timestamp ? parseInt(obj.timestamp, 10) : Date.now(),
    coordinatorPlan: obj.coordinatorPlan
      ? (JSON.parse(obj.coordinatorPlan) as CoordinatorPlan | null) ?? undefined
      : undefined,
  };
}
