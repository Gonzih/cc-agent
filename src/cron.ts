/**
 * CronEngine — schedules recurring jobs stored in Redis.
 *
 * Crons are stored as a JSON array in `cca:crons:<namespace>`.
 * Fires via a 60-second tick; updates lastFiredAt after each fire.
 * On startup migrates `.cc-tg/crons.json` if present.
 */

import { existsSync } from "fs";
import { rename, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import type { JobManager } from "./agent.js";
import { getRedis } from "./redis.js";
import { logger } from "./logger.js";
import { notify } from "./coordinator.js";

export interface CronJob {
  id: string;
  chatId: number;
  intervalMs: number;
  prompt: string;
  schedule: string;  // human label e.g. "every 30m"
  createdAt: string;
  lastFiredAt?: string;
  repoUrl?: string;  // optional — which repo to run on
  enabled?: boolean; // default true; set false to pause without deleting
}

const TICK_INTERVAL_MS = 60_000; // 1 minute

export class CronEngine {
  private running = false;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private manager: JobManager, private namespace: string) {}

  /** Crons Redis key for this namespace. */
  private redisKey(): string {
    return `cca:crons:${this.namespace}`;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info("cron:start", { namespace: this.namespace });
    await this.migrate();
    this.scheduleTick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    logger.info("cron:stop", { namespace: this.namespace });
  }

  private scheduleTick(): void {
    if (!this.running) return;
    this.tickTimer = setTimeout(() => {
      this.tick()
        .catch((err) => logger.warn("cron:tick-error", { err: String(err) }))
        .finally(() => this.scheduleTick());
    }, TICK_INTERVAL_MS);
    if (this.tickTimer && typeof (this.tickTimer as NodeJS.Timeout).unref === "function") {
      (this.tickTimer as NodeJS.Timeout).unref();
    }
  }

  /** Called by tests to trigger a tick immediately without waiting. */
  async tick(): Promise<void> {
    const crons = await this.listCrons();
    const now = Date.now();
    for (const cron of crons) {
      if (cron.enabled === false) continue;
      const lastFired = cron.lastFiredAt ? new Date(cron.lastFiredAt).getTime() : 0;
      if (now - lastFired >= cron.intervalMs) {
        await this.fire(cron);
      }
    }
  }

  private async fire(cron: CronJob): Promise<void> {
    try {
      await notify(this.namespace, `⏰ cron fired: ${cron.schedule}`);
      const jobId = await this.manager.spawn({
        repoUrl: cron.repoUrl ?? "",
        task: cron.prompt,
      });
      logger.info("cron:fired", {
        id: cron.id,
        schedule: cron.schedule,
        jobId,
      });
      await this.updateLastFired(cron.id);
    } catch (err) {
      logger.warn("cron:fire-failed", { id: cron.id, err: String(err) });
    }
  }

  /** Atomically reload from Redis and update lastFiredAt — skips if cron was deleted. */
  private async updateLastFired(id: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    const raw = await redis.get(this.redisKey());
    const crons: CronJob[] = raw ? JSON.parse(raw) : [];
    const idx = crons.findIndex((c) => c.id === id);
    if (idx === -1) return; // was deleted — don't re-add
    crons[idx].lastFiredAt = new Date().toISOString();
    await redis.set(this.redisKey(), JSON.stringify(crons));
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  async listCrons(): Promise<CronJob[]> {
    const redis = getRedis();
    if (!redis) return [];
    const raw = await redis.get(this.redisKey());
    if (!raw) return [];
    try {
      return JSON.parse(raw) as CronJob[];
    } catch {
      return [];
    }
  }

  async addCron(cron: Omit<CronJob, "id" | "createdAt">): Promise<CronJob> {
    const newCron: CronJob = {
      ...cron,
      id: uuidv4(),
      createdAt: new Date().toISOString(),
    };
    const crons = await this.listCrons();
    crons.push(newCron);
    await this.saveCrons(crons);
    logger.info("cron:added", { id: newCron.id, schedule: newCron.schedule });
    return newCron;
  }

  async deleteCron(id: string): Promise<boolean> {
    const crons = await this.listCrons();
    const idx = crons.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    crons.splice(idx, 1);
    await this.saveCrons(crons);
    logger.info("cron:deleted", { id });
    return true;
  }

  async updateCron(id: string, updates: Partial<CronJob>): Promise<CronJob | null> {
    const crons = await this.listCrons();
    const idx = crons.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    crons[idx] = { ...crons[idx], ...updates, id };
    await this.saveCrons(crons);
    return crons[idx];
  }

  private async saveCrons(crons: CronJob[]): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(this.redisKey(), JSON.stringify(crons));
  }

  // ---------------------------------------------------------------------------
  // Migration from .cc-tg/crons.json
  // ---------------------------------------------------------------------------

  private async migrate(): Promise<void> {
    const src = join(process.cwd(), ".cc-tg", "crons.json");
    const done = join(process.cwd(), ".cc-tg", "crons.json.migrated");
    if (!existsSync(src)) return;
    if (existsSync(done)) return;

    try {
      const raw = await readFile(src, "utf-8");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const legacy = JSON.parse(raw) as any[];
      const existing = await this.listCrons();
      const existingIds = new Set(existing.map((c) => c.id));

      let migrated = 0;
      for (const entry of legacy) {
        if (!entry || typeof entry !== "object") continue;
        const cron: CronJob = {
          id: entry.id ?? uuidv4(),
          chatId: entry.chatId ?? 0,
          intervalMs: entry.intervalMs ?? 3600000,
          prompt: entry.prompt ?? "",
          schedule: entry.schedule ?? "unknown",
          createdAt: entry.createdAt ?? new Date().toISOString(),
          lastFiredAt: entry.lastFiredAt,
          repoUrl: entry.repoUrl,
        };
        if (!existingIds.has(cron.id)) {
          existing.push(cron);
          migrated++;
        }
      }
      await this.saveCrons(existing);
      // Mark migration as done (rename, not delete)
      await writeFile(done, new Date().toISOString(), "utf-8");
      logger.info("cron:migration-complete", { migrated, src });
    } catch (err) {
      logger.warn("cron:migration-failed", { src, err: String(err) });
    }
  }
}
