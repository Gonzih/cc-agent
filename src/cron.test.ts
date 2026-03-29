import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CronEngine, type CronJob } from "./cron.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockGetRedis, mockRedisGet, mockRedisSet, mockRedisPublish, mockRedisLpush, mockRedisLtrim } =
  vi.hoisted(() => {
    const store: Record<string, string> = {};
    const mockRedisGet = vi.fn(async (key: string) => store[key] ?? null);
    const mockRedisSet = vi.fn(async (key: string, value: string) => {
      store[key] = value;
      return "OK";
    });
    const mockRedisPublish = vi.fn(async () => 0);
    const mockRedisLpush = vi.fn(async () => 1);
    const mockRedisLtrim = vi.fn(async () => "OK" as string);
    const redisMock = { get: mockRedisGet, set: mockRedisSet, publish: mockRedisPublish, lpush: mockRedisLpush, ltrim: mockRedisLtrim };
    return {
      mockGetRedis: vi.fn(() => redisMock as typeof redisMock | null),
      mockRedisGet,
      mockRedisSet,
      mockRedisPublish,
      mockRedisLpush,
      mockRedisLtrim,
    };
  });

vi.mock("./redis.js", () => ({ getRedis: mockGetRedis }));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./coordinator.js", () => ({
  notify: vi.fn(async () => {}),
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
  // Reset the in-memory store by clearing all keys in the vi.hoisted store
  // We do this by making mockRedisGet return null by default again
  mockRedisGet.mockImplementation(async () => null);
  mockRedisSet.mockImplementation(async (key: string, value: string) => {
    // no persistent state between tests
    return "OK";
  });
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
    // Make set/get work in tandem
    let stored: string | null = null;
    mockRedisGet.mockImplementation(async () => stored);
    mockRedisSet.mockImplementation(async (_key: string, value: string) => {
      stored = value;
      return "OK";
    });

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
    let stored: string | null = null;
    mockRedisGet.mockImplementation(async () => stored);
    mockRedisSet.mockImplementation(async (_key: string, value: string) => {
      stored = value;
      return "OK";
    });

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

  it("updateCron changes the specified fields", async () => {
    let stored: string | null = null;
    mockRedisGet.mockImplementation(async () => stored);
    mockRedisSet.mockImplementation(async (_key: string, value: string) => {
      stored = value;
      return "OK";
    });

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
    mockRedisGet.mockResolvedValue(null);
    const result = await engine.updateCron("ghost", { prompt: "x" });
    expect(result).toBeNull();
  });
});

describe("CronEngine — tick / firing", () => {
  let engine: CronEngine;
  let manager: ReturnType<typeof makeManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = makeManager();
    engine = new CronEngine(manager as any, "test-ns");
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

    let stored = JSON.stringify([cron]);
    mockRedisGet.mockImplementation(async () => stored);
    mockRedisSet.mockImplementation(async (_key: string, value: string) => {
      stored = value;
      return "OK";
    });

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

    mockRedisGet.mockResolvedValue(JSON.stringify([cron]));

    await engine.tick();

    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("fires cron with correct repoUrl when set", async () => {
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

    let stored = JSON.stringify([cron]);
    mockRedisGet.mockImplementation(async () => stored);
    mockRedisSet.mockImplementation(async (_key: string, value: string) => {
      stored = value;
      return "OK";
    });

    await engine.tick();

    expect(manager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: "https://github.com/test/myrepo",
        task: "repo task",
      }),
    );
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

    mockRedisGet.mockResolvedValue(JSON.stringify([cron]));

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

    // First read (tick's listCrons) returns the cron
    // Second read (updateLastFired's reload) returns empty — simulates concurrent delete
    let callCount = 0;
    mockRedisGet.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return JSON.stringify([cron]);
      return JSON.stringify([]); // deleted between tick and updateLastFired
    });
    let savedValue: string | null = null;
    mockRedisSet.mockImplementation(async (_key: string, value: string) => {
      savedValue = value;
      return "OK";
    });

    await engine.tick();

    // spawn was still called (fire happened before the delete check)
    expect(manager.spawn).toHaveBeenCalled();
    // but Redis was NOT written back with the deleted cron
    expect(savedValue).toBeNull();
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

    let stored = JSON.stringify([cron]);
    mockRedisGet.mockImplementation(async () => stored);
    mockRedisSet.mockImplementation(async (_key: string, value: string) => {
      stored = value;
      return "OK";
    });

    await engine.tick();

    const after = JSON.parse(stored) as CronJob[];
    expect(after[0].lastFiredAt).toBeTruthy();
  });
});

describe("CronEngine — migration from crons.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisGet.mockImplementation(async () => null);
    mockRedisSet.mockImplementation(async () => "OK");
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

    let stored: string | null = null;
    mockRedisGet.mockImplementation(async () => stored);
    mockRedisSet.mockImplementation(async (_key: string, value: string) => {
      stored = value;
      return "OK";
    });

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
