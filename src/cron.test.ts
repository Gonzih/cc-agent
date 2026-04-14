import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CronEngine, type CronJob } from "./cron.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  mockGetRedis,
  mockRedisGet,
  mockRedisSet,
  mockRedisPublish,
  mockRedisLpush,
  mockRedisLtrim,
  mockRedisEval,
  mockRedisSmembers,
  mockRedisSadd,
  mockRedisExpire,
  universalEvalImpl,
  store,
  tombstones,
} = vi.hoisted(() => {
  const store: Record<string, string> = {};
  const tombstones: Record<string, Set<string>> = {};

  const mockRedisGet = vi.fn(async (key: string) => store[key] ?? null);
  const mockRedisSet = vi.fn(async (key: string, value: string) => {
    store[key] = value;
    return "OK";
  });
  const mockRedisPublish = vi.fn(async () => 0);
  const mockRedisLpush = vi.fn(async () => 1);
  const mockRedisLtrim = vi.fn(async () => "OK" as string);
  const mockRedisSmembers = vi.fn(async (key: string) => Array.from(tombstones[key] ?? []));
  const mockRedisSadd = vi.fn(async (key: string, ...members: string[]) => {
    if (!tombstones[key]) tombstones[key] = new Set();
    members.forEach((m) => tombstones[key].add(m));
    return members.length;
  });
  const mockRedisExpire = vi.fn(async () => 1);

  // Universal eval dispatcher: JS implementations of each Lua script.
  // Identified by unique snippet in the script body.
  // Exported so clearStore() can restore it after per-test overrides.
  const universalEvalImpl = async (
    script: string,
    _n: number,
    key: string,
    ...args: string[]
  ): Promise<number> => {
    const raw = store[key] ?? null;

    if (script.includes("table.insert(crons, newCron)")) {
      // ADD_CRON_LUA
      const crons = raw ? (JSON.parse(raw) as CronJob[]) : [];
      const newCron = JSON.parse(args[0]) as CronJob;
      if (crons.find((c) => c.id === newCron.id)) return 0;
      crons.push(newCron);
      store[key] = JSON.stringify(crons);
      return 1;
    }

    if (script.includes("for k, v in pairs(updates)")) {
      // UPDATE_CRON_LUA
      if (!raw) return 0;
      const crons = JSON.parse(raw) as CronJob[];
      const idx = crons.findIndex((c) => c.id === args[0]);
      if (idx === -1) return 0;
      const updates = JSON.parse(args[1]) as Partial<CronJob>;
      crons[idx] = { ...crons[idx], ...updates };
      store[key] = JSON.stringify(crons);
      return 1;
    }

    if (script.includes("found = 0")) {
      // DELETE_CRON_LUA
      if (!raw) return 0;
      const crons = JSON.parse(raw) as CronJob[];
      const newCrons: CronJob[] = [];
      let found = 0;
      for (const c of crons) {
        if (c.id === args[0]) found = 1;
        else newCrons.push(c);
      }
      if (found === 1) store[key] = JSON.stringify(newCrons);
      return found;
    }

    // UPDATE_LAST_FIRED_LUA
    if (!raw) return 0;
    const crons = JSON.parse(raw) as CronJob[];
    const idx = crons.findIndex((c) => c.id === args[0]);
    if (idx === -1) return 0;
    crons[idx].lastFiredAt = args[1];
    store[key] = JSON.stringify(crons);
    return 1;
  };

  const mockRedisEval = vi.fn(universalEvalImpl);

  const redisMock = {
    get: mockRedisGet,
    set: mockRedisSet,
    publish: mockRedisPublish,
    lpush: mockRedisLpush,
    ltrim: mockRedisLtrim,
    eval: mockRedisEval,
    smembers: mockRedisSmembers,
    sadd: mockRedisSadd,
    expire: mockRedisExpire,
  };
  return {
    mockGetRedis: vi.fn(() => redisMock as typeof redisMock | null),
    mockRedisGet,
    mockRedisSet,
    mockRedisPublish,
    mockRedisLpush,
    mockRedisLtrim,
    mockRedisEval,
    mockRedisSmembers,
    mockRedisSadd,
    mockRedisExpire,
    universalEvalImpl,
    store,
    tombstones,
  };
});

vi.mock("./redis.js", () => ({ getRedis: mockGetRedis }));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./coordinator.js", () => ({
  notify: vi.fn(async () => {}),
}));

// Mock metaAgentManager so cron routing via messageMetaAgent is testable
// without real fs/process calls.
const mockMessageMetaAgent = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./meta-agent.js", () => ({
  metaAgentManager: { messageMetaAgent: mockMessageMetaAgent },
}));

// fs mocks — default: no crons.json present
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
}));
vi.mock("fs/promises", () => ({
  rename: vi.fn(async () => {}),
  readFile: vi.fn(async () => "[]"),
  writeFile: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager() {
  return {
    spawn: vi.fn(async () => "spawned-job-id"),
  };
}

function clearStore() {
  // Clear all keys in the shared in-memory store
  for (const k of Object.keys(store)) delete store[k];
  for (const k of Object.keys(tombstones)) delete tombstones[k];
  // Reset mock implementations to defaults (use hoisted store).
  // This undoes any per-test .mockResolvedValue() / .mockImplementation() overrides.
  mockRedisGet.mockImplementation(async (key: string) => store[key] ?? null);
  mockRedisSet.mockImplementation(async (key: string, value: string) => {
    store[key] = value;
    return "OK";
  });
  mockRedisSmembers.mockImplementation(async (key: string) =>
    Array.from(tombstones[key] ?? []),
  );
  mockRedisSadd.mockImplementation(async (key: string, ...members: string[]) => {
    if (!tombstones[key]) tombstones[key] = new Set();
    members.forEach((m) => tombstones[key].add(m));
    return members.length;
  });
  mockRedisExpire.mockImplementation(async () => 1);
  mockRedisEval.mockImplementation(universalEvalImpl);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CronEngine — CRUD", () => {
  let engine: CronEngine;
  let manager: ReturnType<typeof makeManager>;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearStore();
    manager = makeManager();
    engine = new CronEngine(manager as any, "test-ns");
    // Skip migration (no crons.json)
    // Don't call start() — we test internals directly to avoid real timers
  });

  it("listCrons returns empty array when no data in Redis", async () => {
    const crons = await engine.listCrons();
    expect(crons).toEqual([]);
  });

  it("addCron persists cron and returns it with id + createdAt", async () => {
    const cron = await engine.addCron({
      chatId: 42,
      intervalMs: 60000,
      prompt: "do stuff",
      schedule: "every 1m",
    });

    expect(cron.id).toBeTruthy();
    expect(cron.createdAt).toBeTruthy();
    expect(cron.prompt).toBe("do stuff");
    expect(cron.intervalMs).toBe(60000);

    const crons = await engine.listCrons();
    expect(crons).toHaveLength(1);
    expect(crons[0].id).toBe(cron.id);
  });

  it("deleteCron removes cron and returns true; returns false for unknown id", async () => {
    const c1 = await engine.addCron({ chatId: 0, intervalMs: 1000, prompt: "p1", schedule: "s1" });
    const c2 = await engine.addCron({ chatId: 0, intervalMs: 2000, prompt: "p2", schedule: "s2" });
    const c3 = await engine.addCron({ chatId: 0, intervalMs: 3000, prompt: "p3", schedule: "s3" });

    expect(await engine.listCrons()).toHaveLength(3);

    const deleted = await engine.deleteCron(c2.id);
    expect(deleted).toBe(true);

    const remaining = await engine.listCrons();
    expect(remaining).toHaveLength(2);
    expect(remaining.find((c) => c.id === c2.id)).toBeUndefined();

    const notFound = await engine.deleteCron("no-such-id");
    expect(notFound).toBe(false);
  });

  it("deleteCron adds id to tombstone set with TTL", async () => {
    const c = await engine.addCron({ chatId: 0, intervalMs: 1000, prompt: "p", schedule: "s" });
    await engine.deleteCron(c.id);

    expect(mockRedisSadd).toHaveBeenCalledWith(
      `cca:deleted-crons:test-ns`,
      c.id,
    );
    expect(mockRedisExpire).toHaveBeenCalledWith(
      `cca:deleted-crons:test-ns`,
      7 * 24 * 3600,
    );
  });

  it("listCrons filters out tombstoned ids even if array still contains them", async () => {
    const c = await engine.addCron({ chatId: 0, intervalMs: 1000, prompt: "ghost", schedule: "s" });

    // Simulate a stale concurrent write restoring the deleted cron to the array
    // (tombstone prevents it from appearing in listCrons)
    tombstones[`cca:deleted-crons:test-ns`] = new Set([c.id]);

    const crons = await engine.listCrons();
    expect(crons.find((x) => x.id === c.id)).toBeUndefined();
  });

  it("updateCron changes the specified fields", async () => {
    const cron = await engine.addCron({ chatId: 0, intervalMs: 5000, prompt: "old", schedule: "old-sched" });
    const updated = await engine.updateCron(cron.id, { intervalMs: 9000, prompt: "new" });

    expect(updated).not.toBeNull();
    expect(updated!.intervalMs).toBe(9000);
    expect(updated!.prompt).toBe("new");
    expect(updated!.schedule).toBe("old-sched"); // unchanged

    const persisted = await engine.listCrons();
    expect(persisted[0].intervalMs).toBe(9000);
  });

  it("updateCron returns null for unknown id", async () => {
    const result = await engine.updateCron("ghost", { prompt: "x" });
    expect(result).toBeNull();
  });

  it("concurrent stale write is neutralised by tombstone on listCrons", async () => {
    // Instance A adds 3 crons and deletes one
    const c1 = await engine.addCron({ chatId: 0, intervalMs: 1000, prompt: "p1", schedule: "s1" });
    const c2 = await engine.addCron({ chatId: 0, intervalMs: 2000, prompt: "p2", schedule: "s2" });
    const c3 = await engine.addCron({ chatId: 0, intervalMs: 3000, prompt: "p3", schedule: "s3" });
    await engine.deleteCron(c2.id); // removes from array AND tombstones

    // Instance B (stale) overwrites Redis array with original 3-cron state
    store[`cca:crons:test-ns`] = JSON.stringify([
      { ...c1 }, { ...c2 }, { ...c3 },
    ]);

    // listCrons must still exclude c2 via tombstone
    const visible = await engine.listCrons();
    expect(visible.find((c) => c.id === c2.id)).toBeUndefined();
    expect(visible).toHaveLength(2);
  });
});

describe("CronEngine — tick / firing", () => {
  let engine: CronEngine;
  let manager: ReturnType<typeof makeManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearStore();
    manager = makeManager();
    engine = new CronEngine(manager as any, "test-ns");
    // Simulate post-startup conditions so jitter logic does not interfere
    (engine as any).startupTime = 0;
  });

  it("fires cron when interval has elapsed", async () => {
    const pastFired = new Date(Date.now() - 200).toISOString();
    const cron: CronJob = {
      id: "c1",
      chatId: 0,
      intervalMs: 100,
      prompt: "fire me",
      schedule: "every 100ms",
      createdAt: new Date().toISOString(),
      lastFiredAt: pastFired,
    };

    store[`cca:crons:test-ns`] = JSON.stringify([cron]);

    await engine.tick();

    expect(manager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "fire me" }),
    );
  });

  it("does NOT fire cron before interval", async () => {
    const justFired = new Date(Date.now() - 10).toISOString();
    const cron: CronJob = {
      id: "c2",
      chatId: 0,
      intervalMs: 60000,
      prompt: "too early",
      schedule: "every 60s",
      createdAt: new Date().toISOString(),
      lastFiredAt: justFired,
    };

    store[`cca:crons:test-ns`] = JSON.stringify([cron]);

    await engine.tick();

    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("fires cron with repoUrl via metaAgentManager.messageMetaAgent, not manager.spawn", async () => {
    const cron: CronJob = {
      id: "c3",
      chatId: 0,
      intervalMs: 50,
      prompt: "repo task",
      schedule: "every 50ms",
      createdAt: new Date().toISOString(),
      repoUrl: "https://github.com/test/myrepo",
      // no lastFiredAt → will fire
    };

    store[`cca:crons:test-ns`] = JSON.stringify([cron]);

    await engine.tick();

    // When a cron has a repoUrl, it routes through the meta-agent (not spawn_agent).
    // The namespace is derived from the last URL path segment: "myrepo".
    expect(mockMessageMetaAgent).toHaveBeenCalledWith(
      "myrepo",
      "repo task",
      "https://github.com/test/myrepo",
    );
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("does NOT fire cron with enabled: false", async () => {
    const cron: CronJob = {
      id: "c-disabled",
      chatId: 0,
      intervalMs: 50,
      prompt: "should not run",
      schedule: "every 50ms",
      createdAt: new Date().toISOString(),
      enabled: false,
      // no lastFiredAt → would fire if enabled
    };

    store[`cca:crons:test-ns`] = JSON.stringify([cron]);

    await engine.tick();

    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("deleted cron is not resurrected by updateLastFired", async () => {
    const cron: CronJob = {
      id: "c-deleted",
      chatId: 0,
      intervalMs: 50,
      prompt: "delete me mid-tick",
      schedule: "fast",
      createdAt: new Date().toISOString(),
    };

    // tick's listCrons sees the cron; but by the time eval runs the cron is gone
    mockRedisGet.mockResolvedValue(JSON.stringify([cron]));
    // Lua eval atomically sees the empty array (concurrent delete happened before eval ran)
    mockRedisEval.mockResolvedValue(0); // 0 = cron not found, nothing written

    await engine.tick();

    // spawn was still called (fire happened before the delete check)
    expect(manager.spawn).toHaveBeenCalled();
    // eval ran but returned 0 — Redis was NOT written back with the deleted cron
    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("updates lastFiredAt after firing", async () => {
    const cron: CronJob = {
      id: "c4",
      chatId: 0,
      intervalMs: 50,
      prompt: "update me",
      schedule: "fast",
      createdAt: new Date().toISOString(),
    };

    store[`cca:crons:test-ns`] = JSON.stringify([cron]);

    await engine.tick();

    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    const after = JSON.parse(store[`cca:crons:test-ns`]) as CronJob[];
    expect(after[0].lastFiredAt).toBeTruthy();
  });
});

describe("CronEngine — startup jitter", () => {
  let engine: CronEngine;
  let manager: ReturnType<typeof makeManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearStore();
    vi.useFakeTimers();
    manager = makeManager();
    // Instantiate AFTER useFakeTimers so startupTime reflects the fake clock
    engine = new CronEngine(manager as any, "test-ns");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("staggers overdue crons on first tick — none fire synchronously", async () => {
    const crons: CronJob[] = [
      { id: "c1", chatId: 0, intervalMs: 50, prompt: "p1", schedule: "s1", createdAt: new Date().toISOString() },
      { id: "c2", chatId: 0, intervalMs: 50, prompt: "p2", schedule: "s2", createdAt: new Date().toISOString() },
      { id: "c3", chatId: 0, intervalMs: 50, prompt: "p3", schedule: "s3", createdAt: new Date().toISOString() },
    ];
    store[`cca:crons:test-ns`] = JSON.stringify(crons);

    await engine.tick();

    // No cron should have fired synchronously during tick()
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("staggers overdue crons 30s apart on first tick", async () => {
    const crons: CronJob[] = [
      { id: "c1", chatId: 0, intervalMs: 50, prompt: "p1", schedule: "s1", createdAt: new Date().toISOString() },
      { id: "c2", chatId: 0, intervalMs: 50, prompt: "p2", schedule: "s2", createdAt: new Date().toISOString() },
      { id: "c3", chatId: 0, intervalMs: 50, prompt: "p3", schedule: "s3", createdAt: new Date().toISOString() },
    ];
    store[`cca:crons:test-ns`] = JSON.stringify(crons);

    await engine.tick();
    expect(manager.spawn).not.toHaveBeenCalled();

    // idx=0 fires at 0ms, idx=1 at 30s, idx=2 at 60s
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(manager.spawn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(manager.spawn).toHaveBeenCalledTimes(3);
  });

  it("fires crons immediately after startup window has passed (120s)", async () => {
    const cron: CronJob = {
      id: "c1",
      chatId: 0,
      intervalMs: 50,
      prompt: "p1",
      schedule: "s1",
      createdAt: new Date().toISOString(),
    };
    store[`cca:crons:test-ns`] = JSON.stringify([cron]);

    // Advance clock past the startup window (TICK_INTERVAL_MS * 2 = 120s)
    vi.advanceTimersByTime(120_001);

    await engine.tick();

    // Should fire synchronously, not deferred
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("does not stagger the same cron twice on repeat ticks within startup window", async () => {
    const cron: CronJob = {
      id: "c1",
      chatId: 0,
      intervalMs: 50,
      prompt: "p1",
      schedule: "s1",
      createdAt: new Date().toISOString(),
    };
    store[`cca:crons:test-ns`] = JSON.stringify([cron]);

    await engine.tick(); // first tick — deferred
    expect(manager.spawn).not.toHaveBeenCalled();

    // Second tick within startup window — cron is already in firedOnStartup, fires immediately
    await engine.tick();
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("CronEngine — migration from crons.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStore();
  });

  it("migrates crons.json to Redis on start", async () => {
    const { existsSync } = await import("fs");
    const { readFile, writeFile } = await import("fs/promises");

    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p.endsWith("crons.json")) return true;
      if (p.endsWith("crons.json.migrated")) return false;
      return false;
    });

    const legacyCrons = [
      { id: "leg-1", chatId: 99, intervalMs: 5000, prompt: "legacy prompt", schedule: "every 5s", createdAt: "2025-01-01T00:00:00Z" },
    ];
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(legacyCrons));

    const manager = makeManager();
    const engine = new CronEngine(manager as any, "test-ns");
    await (engine as any).migrate();

    const crons = await engine.listCrons();
    expect(crons).toHaveLength(1);
    expect(crons[0].id).toBe("leg-1");
    expect(crons[0].prompt).toBe("legacy prompt");
    expect(writeFile).toHaveBeenCalled(); // wrote .migrated file
  });

  it("skips migration if .migrated file exists", async () => {
    const { existsSync } = await import("fs");
    const { readFile } = await import("fs/promises");

    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p.endsWith("crons.json")) return true;
      if (p.endsWith("crons.json.migrated")) return true; // already done
      return false;
    });

    const manager = makeManager();
    const engine = new CronEngine(manager as any, "test-ns");
    await (engine as any).migrate();

    expect(readFile).not.toHaveBeenCalled();
  });
});
