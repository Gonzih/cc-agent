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
import { metaAgentManager } from "./meta-agent.js";

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

// Lua script for atomic check-and-update of lastFiredAt.
// Returns 1 if updated, 0 if cron was not found (e.g. concurrently deleted).
const UPDATE_LAST_FIRED_LUA = `
  local raw = redis.call('GET', KEYS[1])
  if not raw then return 0 end
  local crons = cjson.decode(raw)
  for i, c in ipairs(crons) do
    if c.id == ARGV[1] then
      crons[i].lastFiredAt = ARGV[2]
      redis.call('SET', KEYS[1], cjson.encode(crons))
      return 1
    end
  end
  return 0
`;

// Lua script for atomic deletion of a cron by id.
// Returns 1 if found and removed, 0 if not found.
const DELETE_CRON_LUA = `
  local raw = redis.call('GET', KEYS[1])
  if not raw then return 0 end
  local crons = cjson.decode(raw)
  local new = {}
  local found = 0
  for _, c in ipairs(crons) do
    if c.id == ARGV[1] then
      found = 1
    else
      table.insert(new, c)
    end
  end
  if found == 1 then
    redis.call('SET', KEYS[1], cjson.encode(new))
  end
  return found
`;

// Lua script for atomic addition of a cron (skips if id already exists).
// Returns 1 if added, 0 if duplicate.
const ADD_CRON_LUA = `
  local raw = redis.call('GET', KEYS[1])
  local crons = raw and cjson.decode(raw) or {}
  local newCron = cjson.decode(ARGV[1])
  for _, c in ipairs(crons) do
    if c.id == newCron.id then return 0 end
  end
  table.insert(crons, newCron)
  redis.call('SET', KEYS[1], cjson.encode(crons))
  return 1
`;

// Lua script for atomic update of a cron's fields.
// ARGV[1] = id, ARGV[2] = JSON of partial updates.
// Returns 1 if updated, 0 if not found.
const UPDATE_CRON_LUA = `
  local raw = redis.call('GET', KEYS[1])
  if not raw then return 0 end
  local crons = cjson.decode(raw)
  local updates = cjson.decode(ARGV[2])
  for i, c in ipairs(crons) do
    if c.id == ARGV[1] then
      for k, v in pairs(updates) do
        crons[i][k] = v
      end
      redis.call('SET', KEYS[1], cjson.encode(crons))
      return 1
    end
  end
  return 0
`;

export class CronEngine {
  private running = false;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly startupTime = Date.now();
  private readonly firedOnStartup = new Set<string>();

  constructor(private manager: JobManager, private namespace: string) {}

  /** Crons Redis key for this namespace. */
  private redisKey(): string {
    return `cca:crons:${this.namespace}`;
  }

  /** Tombstone set key — deleted cron ids, TTL 7 days. */
  private deletedKey(): string {
    return `cca:deleted-crons:${this.namespace}`;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info("[cron] start", { namespace: this.namespace });
    await this.migrate();
    this.scheduleTick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    logger.info("[cron] stop", { namespace: this.namespace });
  }

  private scheduleTick(): void {
    if (!this.running) return;
    this.tickTimer = setTimeout(() => {
      this.tick()
        .catch((err) => logger.warn("[cron] tick-error", { err: String(err) }))
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
    const isFirstTick = now - this.startupTime < TICK_INTERVAL_MS * 2;

    for (const cron of crons) {
      if (cron.enabled === false) continue;
      const lastFired = cron.lastFiredAt ? new Date(cron.lastFiredAt).getTime() : 0;
      if (now - lastFired >= cron.intervalMs) {
        if (isFirstTick && !this.firedOnStartup.has(cron.id)) {
          // Spread startup fires: stagger by index * 30s to avoid thundering herd
          const idx = crons.indexOf(cron);
          setTimeout(() => this.fire(cron).catch(() => {}), idx * 30_000);
          this.firedOnStartup.add(cron.id);
        } else {
          await this.fire(cron);
        }
      }
    }
  }

  private async fire(cron: CronJob): Promise<void> {
    try {
      logger.info("[cron] fired", {
        id: cron.id,
        schedule: cron.schedule,
        intervalMs: cron.intervalMs,
        prompt: cron.prompt.slice(0, 200),
      });

      // Derive a namespace from the cron's repoUrl if available.
      // e.g. https://github.com/gonzih/polly-gamba → polly-gamba
      const cronNamespace = this.resolveNamespace(cron);

      if (cronNamespace) {
        // Route through meta-agent: start if not running, then message it.
        logger.info("[cron] routing-to-meta-agent", {
          id: cron.id,
          schedule: cron.schedule,
          namespace: cronNamespace,
        });
        await metaAgentManager.messageMetaAgent(cronNamespace, cron.prompt, cron.repoUrl);
        logger.info("[cron] fired-via-meta-agent", {
          id: cron.id,
          schedule: cron.schedule,
          namespace: cronNamespace,
        });
      } else {
        // Fallback: no namespace/repo → spawn an isolated agent as before.
        logger.info("[cron] fallback-spawn-agent", {
          id: cron.id,
          schedule: cron.schedule,
        });
        const jobId = await this.manager.spawn({
          repoUrl: cron.repoUrl ?? "",
          task: cron.prompt,
        });
        logger.info("[cron] fired-via-spawn", {
          id: cron.id,
          schedule: cron.schedule,
          jobId,
        });
      }

      await this.updateLastFired(cron.id);
    } catch (err) {
      logger.warn("[cron] fire-failed", { id: cron.id, err: String(err) });
    }
  }

  /**
   * Resolve a meta-agent namespace from a CronJob.
   * Returns null when no repo is associated (fallback to spawn_agent).
   *
   * Priority:
   *   1. cron.repoUrl — extract last path segment as namespace
   *   2. no repoUrl → null (use spawn_agent fallback)
   */
  private resolveNamespace(cron: CronJob): string | null {
    if (!cron.repoUrl) return null;
    try {
      const url = new URL(cron.repoUrl);
      const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
      const repoName = parts[parts.length - 1];
      if (repoName) return repoName;
    } catch {
      // Not a valid URL — try splitting on /
      const parts = cron.repoUrl.replace(/\/$/, "").split("/");
      const repoName = parts[parts.length - 1];
      if (repoName) return repoName;
    }
    return null;
  }

  /** Atomically update lastFiredAt via Lua script — skips if cron was deleted concurrently. */
  private async updateLastFired(id: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    await redis.eval(UPDATE_LAST_FIRED_LUA, 1, this.redisKey(), id, new Date().toISOString());
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  async listCrons(): Promise<CronJob[]> {
    const redis = getRedis();
    if (!redis) return [];
    const [raw, deletedMembers] = await Promise.all([
      redis.get(this.redisKey()),
      redis.smembers(this.deletedKey()),
    ]);
    if (!raw) return [];
    try {
      const deletedSet = new Set(deletedMembers);
      const all = JSON.parse(raw) as CronJob[];
      return all.filter((c) => !deletedSet.has(c.id));
    } catch {
      return [];
    }
  }

  async addCron(cron: Omit<CronJob, "id" | "createdAt">): Promise<CronJob> {
    const redis = getRedis();
    const newCron: CronJob = {
      ...cron,
      id: uuidv4(),
      createdAt: new Date().toISOString(),
    };
    if (redis) {
      await redis.eval(ADD_CRON_LUA, 1, this.redisKey(), JSON.stringify(newCron));
    }
    logger.info("[cron] added", { id: newCron.id, schedule: newCron.schedule, intervalMs: newCron.intervalMs });
    return newCron;
  }

  async deleteCron(id: string): Promise<boolean> {
    const redis = getRedis();
    if (!redis) return false;
    const found = await redis.eval(DELETE_CRON_LUA, 1, this.redisKey(), id);
    if (found === 1) {
      await redis.sadd(this.deletedKey(), id);
      await redis.expire(this.deletedKey(), 7 * 24 * 3600);
      logger.info("[cron] deleted", { id });
    }
    return found === 1;
  }

  async updateCron(id: string, updates: Partial<CronJob>): Promise<CronJob | null> {
    const redis = getRedis();
    if (!redis) return null;
    const found = await redis.eval(UPDATE_CRON_LUA, 1, this.redisKey(), id, JSON.stringify(updates));
    if (!found) return null;
    // Read back the merged cron — we need the full object as the return value
    const crons = await this.listCrons();
    return crons.find((c) => c.id === id) ?? null;
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
      logger.info("[cron] migration-complete", { migrated, src });
    } catch (err) {
      logger.warn("[cron] migration-failed", { src, err: String(err) });
    }
  }
}
