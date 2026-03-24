import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getRedis } from "./redis.js";
import { getNamespace, jobIndexKey } from "./namespace.js";
import {
  loadPersistedJobs,
  savePersistedJobs,
  appendLog,
  readLogSync,
  type PersistedJob,
} from "./state.js";
import type { JobStatus, TokenUsage } from "./types.js";
import { logger } from "./logger.js";

const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;   // 7 days
const PLAN_TTL_SECONDS = 30 * 24 * 60 * 60;  // 30 days

// ─── Profile disk helpers ────────────────────────────────────────────────────

const PROFILES_DIR = join(homedir(), ".cc-agent");
const PROFILES_FILE = join(PROFILES_DIR, "profiles.json");

function diskLoadProfiles(): Profile[] {
  if (!existsSync(PROFILES_FILE)) return [];
  try { return JSON.parse(readFileSync(PROFILES_FILE, "utf-8")) as Profile[]; }
  catch { return []; }
}

function diskSaveProfiles(profiles: Profile[]): void {
  mkdirSync(PROFILES_DIR, { recursive: true });
  writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), "utf-8");
}

// ─── Job Record ──────────────────────────────────────────────────────────────

export interface JobRecord {
  id: string;
  status: JobStatus;
  repoUrl: string;
  task: string;
  branch?: string;
  createBranch?: string;
  dependsOn?: string[];
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  pid?: number;
  sessionIdAfter?: string;
  usage?: TokenUsage;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  costUsd?: number;
  recentTools: string[];
  outputLineCount: number;
  sleepUntil?: string;
  sleepReason?: string;
  approvalIssueUrl?: string;
  approvalRepo?: string;
  approvalIssueNumber?: number;
  score?: number | null;
  scoreSource?: "self_reported" | "heuristic" | null;
  variantIndex?: number;
  parentVariant?: string;
  siblings?: string[];
  dockerIsolation?: boolean;
  isolation?: "docker" | "host";
  resumedFrom?: string;
}

export class JobStore {
  private memJobs = new Map<string, JobRecord>();            // id → record (global lookup)
  private memIndex = new Map<string, Set<string>>();         // namespace → set of ids

  async saveJob(record: JobRecord): Promise<void> {
    const redis = getRedis();
    if (redis) {
      try {
        await redis.set(`cca:job:${record.id}`, JSON.stringify(record), "EX", JOB_TTL_SECONDS);
        await redis.sadd(jobIndexKey(), record.id);
        logger.info("store:saveJob", { id: record.id, status: record.status });
        return;
      } catch (err) {
        logger.error("store:saveJob Redis failed", err);
      }
    }
    this.memJobs.set(record.id, record);
    const ns = getNamespace();
    if (!this.memIndex.has(ns)) this.memIndex.set(ns, new Set());
    this.memIndex.get(ns)!.add(record.id);
    this.flushToDisk();
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const redis = getRedis();
    if (redis) {
      try {
        const raw = await redis.get(`cca:job:${id}`);
        return raw ? (JSON.parse(raw) as JobRecord) : null;
      } catch (err) {
        logger.error("store:getJob Redis failed", err);
      }
    }
    return this.memJobs.get(id) ?? null;
  }

  async listJobs(): Promise<JobRecord[]> {
    const redis = getRedis();
    if (redis) {
      try {
        const ids = await redis.smembers(jobIndexKey());
        if (!ids.length) return [];
        const pipeline = redis.pipeline();
        for (const id of ids) pipeline.get(`cca:job:${id}`);
        const results = await pipeline.exec();
        const jobs: JobRecord[] = [];
        for (const [, val] of results ?? []) {
          if (val) {
            try { jobs.push(JSON.parse(val as string) as JobRecord); } catch {}
          }
        }
        return jobs;
      } catch (err) {
        logger.error("store:listJobs Redis failed", err);
      }
    }
    const ns = getNamespace();
    const ids = this.memIndex.get(ns) ?? new Set<string>();
    return Array.from(ids)
      .map((id) => this.memJobs.get(id))
      .filter((r): r is JobRecord => r !== undefined);
  }

  async appendOutput(id: string, line: string): Promise<void> {
    const redis = getRedis();
    if (redis) {
      try {
        const key = `cca:job:${id}:output`;
        await redis.rpush(key, line);
        await redis.expire(key, JOB_TTL_SECONDS);
        return;
      } catch (err) {
        logger.error("store:appendOutput Redis failed", err);
      }
    }
    appendLog(id, line);
  }

  async getOutput(id: string, offset: number): Promise<string[]> {
    const redis = getRedis();
    if (redis) {
      try {
        return await redis.lrange(`cca:job:${id}:output`, offset, -1);
      } catch (err) {
        logger.error("store:getOutput Redis failed", err);
      }
    }
    return readLogSync(id, offset);
  }

  async updateJob(id: string, partial: Partial<JobRecord>): Promise<void> {
    const existing = await this.getJob(id);
    if (existing) {
      await this.saveJob({ ...existing, ...partial });
    }
  }

  /** Load all persisted jobs on startup: Redis first, disk fallback. */
  async loadAll(): Promise<JobRecord[]> {
    const redis = getRedis();
    if (redis) {
      try {
        const jobs = await this.listJobs();
        if (jobs.length > 0) return jobs;
      } catch (err) {
        logger.error("store:loadAll Redis failed", err);
      }
    }
    return loadPersistedJobs().map((p) => ({
      ...p,
      recentTools: [],
      outputLineCount: 0,
    }));
  }

  private flushToDisk(): void {
    try {
      const records: PersistedJob[] = Array.from(this.memJobs.values()).map((r) => ({
        id: r.id,
        status: r.status,
        repoUrl: r.repoUrl,
        task: r.task,
        branch: r.branch,
        createBranch: r.createBranch,
        startedAt: r.startedAt ?? new Date().toISOString(),
        finishedAt: r.finishedAt,
        exitCode: r.exitCode,
        error: r.error,
        pid: r.pid,
        sessionIdAfter: r.sessionIdAfter,
        usage: r.usage,
        totalInputTokens: r.totalInputTokens,
        totalOutputTokens: r.totalOutputTokens,
        totalCacheReadTokens: r.totalCacheReadTokens,
        totalCacheWriteTokens: r.totalCacheWriteTokens,
        costUsd: r.costUsd,
        dependsOn: r.dependsOn,
        score: r.score,
        variantIndex: r.variantIndex,
        parentVariant: r.parentVariant,
        siblings: r.siblings,
      }));
      savePersistedJobs(records);
    } catch (err) {
      logger.error("store:flushToDisk failed", err);
    }
  }
}

// ─── Profile ─────────────────────────────────────────────────────────────────

export interface Profile {
  name: string;
  repoUrl: string;
  taskTemplate: string;
  defaultBudgetUsd?: number;
  branch?: string;
  description?: string;
  preamble?: string;
  createdAt: string;
}

export class ProfileStore {
  async saveProfile(profile: Profile): Promise<void> {
    const redis = getRedis();
    if (redis) {
      try {
        await redis.set(`cca:profile:${profile.name}`, JSON.stringify(profile));
        await redis.sadd("cca:profiles:index", profile.name);
        return;
      } catch (err) {
        logger.error("store:saveProfile Redis failed", err);
      }
    }
    const profiles = diskLoadProfiles();
    const idx = profiles.findIndex((p) => p.name === profile.name);
    if (idx >= 0) profiles[idx] = profile; else profiles.push(profile);
    diskSaveProfiles(profiles);
  }

  async getProfile(name: string): Promise<Profile | null> {
    const redis = getRedis();
    if (redis) {
      try {
        const raw = await redis.get(`cca:profile:${name}`);
        return raw ? (JSON.parse(raw) as Profile) : null;
      } catch (err) {
        logger.error("store:getProfile Redis failed", err);
      }
    }
    return diskLoadProfiles().find((p) => p.name === name) ?? null;
  }

  async listProfiles(): Promise<Profile[]> {
    const redis = getRedis();
    if (redis) {
      try {
        const names = await redis.smembers("cca:profiles:index");
        if (!names.length) {
          // Migrate disk profiles to Redis on first run
          const disk = diskLoadProfiles();
          for (const p of disk) await this.saveProfile(p);
          return disk;
        }
        const pipeline = redis.pipeline();
        for (const name of names) pipeline.get(`cca:profile:${name}`);
        const results = await pipeline.exec();
        const profiles: Profile[] = [];
        for (const [, val] of results ?? []) {
          if (val) {
            try { profiles.push(JSON.parse(val as string) as Profile); } catch {}
          }
        }
        return profiles.sort((a, b) => a.name.localeCompare(b.name));
      } catch (err) {
        logger.error("store:listProfiles Redis failed", err);
      }
    }
    return diskLoadProfiles();
  }

  async deleteProfile(name: string): Promise<boolean> {
    const redis = getRedis();
    if (redis) {
      try {
        const deleted = await redis.del(`cca:profile:${name}`);
        await redis.srem("cca:profiles:index", name);
        return deleted > 0;
      } catch (err) {
        logger.error("store:deleteProfile Redis failed", err);
      }
    }
    const profiles = diskLoadProfiles();
    const idx = profiles.findIndex((p) => p.name === name);
    if (idx < 0) return false;
    profiles.splice(idx, 1);
    diskSaveProfiles(profiles);
    return true;
  }
}

// ─── Plan Record ─────────────────────────────────────────────────────────────

export interface PlanRecord {
  id: string;
  goal: string;
  steps: Array<{ stepId: string; jobId: string; status: string }>;
  createdAt: string;
}

export class PlanStore {
  async savePlan(plan: PlanRecord): Promise<void> {
    const redis = getRedis();
    if (redis) {
      try {
        await redis.set(`cca:plan:${plan.id}`, JSON.stringify(plan), "EX", PLAN_TTL_SECONDS);
        return;
      } catch (err) {
        logger.error("store:savePlan Redis failed", err);
      }
    }
    // No disk fallback for plans — they are best-effort metadata
  }

  async getPlan(id: string): Promise<PlanRecord | null> {
    const redis = getRedis();
    if (redis) {
      try {
        const raw = await redis.get(`cca:plan:${id}`);
        return raw ? (JSON.parse(raw) as PlanRecord) : null;
      } catch (err) {
        logger.error("store:getPlan Redis failed", err);
      }
    }
    return null;
  }
}

// ─── Learnings Store ─────────────────────────────────────────────────────────

const LEARNINGS_MAX = 50;
const LEARNINGS_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

export class LearningsStore {
  private memLearnings = new Map<string, string[]>(); // namespace → entries (newest first)

  private learningsKey(namespace: string): string {
    return `cca:learnings:${namespace}`;
  }

  async addLearning(namespace: string, content: string): Promise<void> {
    const redis = getRedis();
    if (redis) {
      try {
        const key = this.learningsKey(namespace);
        await redis.lpush(key, content);
        await redis.ltrim(key, 0, LEARNINGS_MAX - 1);
        await redis.expire(key, LEARNINGS_TTL_SECONDS);
        logger.info("learnings:added", { namespace, length: content.length });
        return;
      } catch (err) {
        logger.error("learnings:addLearning Redis failed", err);
      }
    }
    const list = this.memLearnings.get(namespace) ?? [];
    list.unshift(content);
    if (list.length > LEARNINGS_MAX) list.splice(LEARNINGS_MAX);
    this.memLearnings.set(namespace, list);
  }

  async getLearnings(namespace: string, limit = 10): Promise<string[]> {
    const redis = getRedis();
    if (redis) {
      try {
        return await redis.lrange(this.learningsKey(namespace), 0, limit - 1);
      } catch (err) {
        logger.error("learnings:getLearnings Redis failed", err);
      }
    }
    return (this.memLearnings.get(namespace) ?? []).slice(0, limit);
  }

  async clearLearnings(namespace: string): Promise<void> {
    const redis = getRedis();
    if (redis) {
      try {
        await redis.del(this.learningsKey(namespace));
        logger.info("learnings:cleared", { namespace });
        return;
      } catch (err) {
        logger.error("learnings:clearLearnings Redis failed", err);
      }
    }
    this.memLearnings.delete(namespace);
  }

  async getLearningsCount(namespace: string): Promise<number> {
    const redis = getRedis();
    if (redis) {
      try {
        return await redis.llen(this.learningsKey(namespace));
      } catch (err) {
        logger.error("learnings:getLearningsCount Redis failed", err);
      }
    }
    return (this.memLearnings.get(namespace) ?? []).length;
  }
}

// ─── Singletons ──────────────────────────────────────────────────────────────

export const jobStore = new JobStore();
export const profileStore = new ProfileStore();
export const planStore = new PlanStore();
export const learningsStore = new LearningsStore();
