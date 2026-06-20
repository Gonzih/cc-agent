/**
 * Coordinator — reads from the Redis Stream and publishes job completion
 * notifications to cca:notify:<namespace> and cca:discord:notify:<namespace>.
 *
 * Uses XREADGROUP with consumer group "coordinator" for reliable delivery.
 * MKSTREAM ensures the stream exists before any producers write to it.
 */

import type { JobEvent } from "./types.js";
import { getRedis } from "./redis.js";
import { logger } from "./logger.js";
import {
  EVENT_STREAM as STREAM_KEY,
  notifyChannel,
  notifyLogKey,
  discordNotify,
  type NotificationPayload,
} from "@gonzih/cc-wire";

/** Consumer group name for reading the event stream. */
const COORDINATOR_GROUP = "coordinator";

const COORDINATOR_POLL_MS = 2000;
const LOW_SCORE_THRESHOLD = 0.5;

/** Publish to both pub/sub channel (live) and a capped LIST (queryable). */
export async function notify(namespace: string, text: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const payload: NotificationPayload = { text };
  const payloadStr = JSON.stringify(payload);
  try {
    await redis.publish(notifyChannel(namespace), payloadStr);
    await redis.lpush(notifyLogKey(namespace), payloadStr);
    await redis.ltrim(notifyLogKey(namespace), 0, 99);
  } catch (err) {
    logger.warn("coordinator:notify-failed", { namespace, err: String(err) });
  }
}

/** Publish a structured payload object directly — no double-wrapping. */
export async function notifyPayload(namespace: string, payload: Record<string, unknown>): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const payloadStr = JSON.stringify(payload);
  try {
    await redis.publish(notifyChannel(namespace), payloadStr);
    await redis.rpush(discordNotify(namespace), payloadStr);
    await redis.lpush(notifyLogKey(namespace), payloadStr);
    await redis.ltrim(notifyLogKey(namespace), 0, 99);
  } catch (err) {
    logger.warn("coordinator:notify-payload-failed", { namespace, err: String(err) });
  }
}

export class Coordinator {
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private namespace: string) {}

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
    const { jobId, status, title, repoUrl, score, spawningNamespace, cronId, chatId } = event;

    if (status === "done" || status === "failed" || status === "loop_exhausted" || status === "loop_stalled") {
      const icon = status === "done" ? "✅" : (status === "loop_exhausted" || status === "loop_stalled") ? "⚠️" : "❌";
      // Parse org/repo from repoUrl (e.g. https://github.com/gonzih/cc-tg → gonzih/cc-tg)
      let repoShort = repoUrl;
      try {
        const url = new URL(repoUrl);
        const parts = url.pathname.replace(/^\//, "").replace(/\/$/, "").split("/");
        if (parts.length >= 2) repoShort = parts.slice(-2).join("/");
      } catch {
        // repoUrl is not a valid URL — use as-is
      }
      const shortId = jobId.slice(0, 8);
      const scorePart = typeof score === "number" ? ` · ${score.toFixed(2)}` : "";
      const scoreStr = scorePart;
      const line1 = `${icon} ${repoShort}${scoreStr} · ${shortId}`;
      const line2 = title.slice(0, 160);
      const targetNamespace = spawningNamespace ?? this.namespace;
      if (chatId) {
        await notifyPayload(targetNamespace, {
          text: `${icon} ${line2}${scoreStr} (job_id: ${jobId})\n${repoUrl}`,
          chat_id: chatId,
          ...(cronId ? { is_cron: true, cron_id: cronId } : {}),
        });
      } else if (cronId) {
        await notifyPayload(targetNamespace, { text: `${icon} ${line2}${scoreStr} (job_id: ${jobId})\n${repoUrl}`, is_cron: true, cron_id: cronId });
      } else {
        await notifyPayload(targetNamespace, { text: `${line1}\n${line2}` });
      }
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
    spawningNamespace: obj.spawningNamespace || undefined,
    cronId: obj.cronId || undefined,
    chatId: obj.chatId ? parseInt(obj.chatId, 10) : undefined,
  };
}
