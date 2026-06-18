import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Coordinator, notify } from "./coordinator.js";
import type { JobEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  mockGetRedis,
  mockRedisPublish,
  mockRedisLpush,
  mockRedisRpush,
  mockRedisLtrim,
  mockRedisXreadgroup,
  mockRedisXgroup,
  mockRedisXack,
} = vi.hoisted(() => {
  const mockRedisPublish = vi.fn(async () => 0);
  const mockRedisLpush = vi.fn(async () => 1);
  const mockRedisRpush = vi.fn(async () => 1);
  const mockRedisLtrim = vi.fn(async () => "OK" as string);
  const mockRedisXreadgroup = vi.fn(async () => null as null | [string, [string, string[]][]][]);
  const mockRedisXgroup = vi.fn(async () => "OK" as string);
  const mockRedisXack = vi.fn(async () => 1);
  const mockRedisFull = {
    publish: mockRedisPublish,
    lpush: mockRedisLpush,
    rpush: mockRedisRpush,
    ltrim: mockRedisLtrim,
    xreadgroup: mockRedisXreadgroup,
    xgroup: mockRedisXgroup,
    xack: mockRedisXack,
  };
  return {
    mockGetRedis: vi.fn(() => mockRedisFull as typeof mockRedisFull | null),
    mockRedisPublish,
    mockRedisLpush,
    mockRedisRpush,
    mockRedisLtrim,
    mockRedisXreadgroup,
    mockRedisXgroup,
    mockRedisXack,
  };
});

vi.mock("./redis.js", () => ({ getRedis: mockGetRedis }));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager() {
  return {
    spawn: vi.fn(async () => "child-job-id"),
    list: vi.fn(() => []),
  };
}

function makeEvent(overrides: Partial<JobEvent> = {}): JobEvent {
  return {
    jobId: "job-1",
    status: "done",
    title: "Test job",
    repoUrl: "https://github.com/test/repo",
    lastLines: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeStreamEntry(event: JobEvent): [string, [string, string[]][]] {
  const fields: string[] = [
    "jobId", event.jobId,
    "status", event.status,
    "title", event.title,
    "repoUrl", event.repoUrl,
    "lastLines", JSON.stringify(event.lastLines),
    "coordinatorPlan", JSON.stringify(event.coordinatorPlan ?? null),
    "score", event.score !== undefined ? String(event.score) : "",
    "timestamp", event.timestamp,
  ];
  return ["cca:event-stream", [["1-1", fields]]];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("notify()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes JSON payload to channel and appends to log list", async () => {
    await notify("test-ns", "hello world");
    const expectedPayload = JSON.stringify({ text: "hello world" });
    expect(mockRedisPublish).toHaveBeenCalledWith("cca:notify:test-ns", expectedPayload);
    expect(mockRedisLpush).toHaveBeenCalledWith("cca:notify-log:test-ns", expectedPayload);
    expect(mockRedisLtrim).toHaveBeenCalledWith("cca:notify-log:test-ns", 0, 99);
  });

  it("does nothing when redis is unavailable", async () => {
    mockGetRedis.mockReturnValueOnce(null);
    await notify("ns", "msg");
    expect(mockRedisPublish).not.toHaveBeenCalled();
  });
});

describe("Coordinator", () => {
  let manager: ReturnType<typeof makeManager>;
  let coordinator: Coordinator;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset xreadgroup mock queue to prevent pollution between tests —
    // vi.clearAllMocks() clears calls but NOT queued mockResolvedValueOnce values.
    mockRedisXreadgroup.mockReset();
    mockRedisXreadgroup.mockResolvedValue(null); // safe default: no entries
    mockRedisXgroup.mockResolvedValue("OK");
    mockRedisXack.mockResolvedValue(1);
    manager = makeManager();
    coordinator = new Coordinator(manager as any, "test-ns");
  });

  afterEach(async () => {
    await coordinator.stop();
  });

  // Test 1: onComplete chain fires on job completion via coordinator_plan
  it("spawns next job when coordinator_plan.next_step is set on done event", async () => {
    const event = makeEvent({
      status: "done",
      coordinatorPlan: { next_step: { repo_url: "https://github.com/test/next", task: "do next thing" } },
    });

    await coordinator.processEvent(event);

    expect(manager.spawn).toHaveBeenCalledWith({
      repoUrl: "https://github.com/test/next",
      task: "do next thing",
    });
  });

  // Test 2: coordinator_plan from Redis stream entry fires on completion
  it("reads coordinatorPlan from stream event and spawns next job", async () => {
    const event = makeEvent({
      coordinatorPlan: { next_step: { repo_url: "https://github.com/test/child", task: "child task" } },
    });
    // poll() calls xreadgroup once (with '>') — one mock value is enough
    mockRedisXreadgroup.mockResolvedValueOnce([makeStreamEntry(event)]);

    await (coordinator as any).poll();

    expect(manager.spawn).toHaveBeenCalledWith({
      repoUrl: "https://github.com/test/child",
      task: "child task",
    });
  });

  // Test 3: Failed job triggers JSON notification
  it("publishes JSON failure notification on failed event", async () => {
    const event = makeEvent({ status: "failed", title: "My Job", repoUrl: "https://github.com/test/repo" });
    await coordinator.processEvent(event);

    expect(mockRedisPublish).toHaveBeenCalledWith(
      "cca:notify:test-ns",
      JSON.stringify({ text: "❌ test/repo · job-1\nMy Job" }),
    );
  });

  // Test 4a: notifyPayload also rpushes to discordNotify list for polling delivery
  it("rpushes payload to discordNotify list for cc-discord polling", async () => {
    const event = makeEvent({ status: "done", title: "My Task", repoUrl: "https://github.com/test/repo" });
    await coordinator.processEvent(event);

    expect(mockRedisRpush).toHaveBeenCalledWith(
      "cca:discord:notify:test-ns",
      JSON.stringify({ text: "✅ test/repo · job-1\nMy Task" }),
    );
  });

  // Test 4: Coordinator survives Redis error and continues processing
  it("logs error but continues when xreadgroup throws", async () => {
    mockRedisXreadgroup.mockRejectedValueOnce(new Error("connection lost"));
    // Should not throw
    await expect((coordinator as any).poll()).resolves.toBeUndefined();
  });

  it("logs error but continues when processEvent throws", async () => {
    manager.spawn.mockRejectedValueOnce(new Error("spawn failed"));
    const event = makeEvent({
      coordinatorPlan: { next_step: { repo_url: "https://github.com/x/y", task: "t" } },
    });
    mockRedisXreadgroup.mockResolvedValueOnce([makeStreamEntry(event)]);
    await expect((coordinator as any).poll()).resolves.toBeUndefined();
  });

  // Test 5: Missed events replayed on startup
  it("replays events written before coordinator starts", async () => {
    const events = [
      makeEvent({ jobId: "a", coordinatorPlan: { next_step: { repo_url: "https://github.com/r/a", task: "t1" } } }),
      makeEvent({ jobId: "b", status: "failed" }),
      makeEvent({ jobId: "c", status: "done", score: 0.3 }),
    ];

    // All three entries returned in one xreadgroup call (replay '0')
    const allEntries: [string, string[]][] = events.map((e, i) => {
      const fields: string[] = [
        "jobId", e.jobId,
        "status", e.status,
        "title", e.title,
        "repoUrl", e.repoUrl,
        "lastLines", "[]",
        "coordinatorPlan", JSON.stringify(e.coordinatorPlan ?? null),
        "score", e.score !== undefined ? String(e.score) : "",
        "timestamp", new Date().toISOString(),
      ];
      return [`${i + 1}-0`, fields];
    });

    // replayMissedEvents returns entries; subsequent poll returns nothing
    mockRedisXreadgroup
      .mockResolvedValueOnce([["cca:event-stream", allEntries]]) // replay
      .mockResolvedValueOnce(null); // poll after start

    await coordinator.start();
    await coordinator.stop();

    // Job "a" had a next_step so spawn should have been called
    expect(manager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: "https://github.com/r/a" }),
    );
    // Job "b" was failed → JSON notification
    expect(mockRedisPublish).toHaveBeenCalledWith(
      "cca:notify:test-ns",
      expect.stringContaining("❌"),
    );
  });

  // start() creates consumer group with MKSTREAM
  it("creates consumer group with MKSTREAM on start", async () => {
    mockRedisXreadgroup.mockResolvedValue(null);
    await coordinator.start();
    await coordinator.stop();

    expect(mockRedisXgroup).toHaveBeenCalledWith(
      "CREATE", "cca:event-stream", "coordinator", "0", "MKSTREAM"
    );
  });

  // start() ignores BUSYGROUP error (group already exists)
  it("ignores BUSYGROUP error when consumer group already exists", async () => {
    mockRedisXgroup.mockRejectedValueOnce(new Error("BUSYGROUP Consumer Group name already exists"));
    mockRedisXreadgroup.mockResolvedValue(null);
    // Should not throw
    await expect(coordinator.start()).resolves.toBeUndefined();
    await coordinator.stop();
  });

  // ACK is sent after successful event processing
  it("ACKs processed entries in the consumer group", async () => {
    const event = makeEvent({ status: "done" });
    mockRedisXreadgroup.mockResolvedValueOnce([makeStreamEntry(event)]);
    await (coordinator as any).poll();
    expect(mockRedisXack).toHaveBeenCalledWith("cca:event-stream", "coordinator", "1-1");
  });

  // Done event notifies with new two-line format (no score when undefined) — JSON payload
  it("notifies JSON ✅ done for a standard done event", async () => {
    const event = makeEvent({ status: "done", title: "My Task", repoUrl: "https://github.com/test/repo" });
    await coordinator.processEvent(event);

    expect(mockRedisPublish).toHaveBeenCalledWith(
      "cca:notify:test-ns",
      JSON.stringify({ text: "✅ test/repo · job-1\nMy Task" }),
    );
  });

  // Done event with coordinatorPlan still notifies ✅ done (and spawns next)
  it("notifies JSON ✅ done even when coordinatorPlan fires", async () => {
    const event = makeEvent({
      status: "done",
      title: "Parent Task",
      repoUrl: "https://github.com/test/repo",
      coordinatorPlan: { next_step: { repo_url: "https://github.com/test/next", task: "next" } },
    });
    await coordinator.processEvent(event);

    expect(manager.spawn).toHaveBeenCalled();
    expect(mockRedisPublish).toHaveBeenCalledWith(
      "cca:notify:test-ns",
      JSON.stringify({ text: "✅ test/repo · job-1\nParent Task" }),
    );
  });

  // Score is included in notification message
  it("includes score in JSON notification when score is present on done event", async () => {
    const event = makeEvent({ status: "done", score: 0.3, title: "Low scorer", repoUrl: "https://github.com/test/repo" });
    await coordinator.processEvent(event);

    expect(mockRedisPublish).toHaveBeenCalledWith(
      "cca:notify:test-ns",
      JSON.stringify({ text: "✅ test/repo · 0.30 · job-1\nLow scorer" }),
    );
  });

  // All done jobs notify with score embedded
  it("publishes JSON done notification with score for high-score done event", async () => {
    const event = makeEvent({ status: "done", score: 0.8, title: "Great Job", repoUrl: "https://github.com/test/repo" });
    await coordinator.processEvent(event);

    expect(mockRedisPublish).toHaveBeenCalledWith(
      "cca:notify:test-ns",
      JSON.stringify({ text: "✅ test/repo · 0.80 · job-1\nGreat Job" }),
    );
  });

  // processEvent with non-URL repoUrl uses raw string fallback
  it("uses raw repoUrl when it is not a valid URL", async () => {
    const event = makeEvent({ status: "done", title: "Bare repo", repoUrl: "not-a-url" });
    await coordinator.processEvent(event);

    expect(mockRedisPublish).toHaveBeenCalledWith(
      "cca:notify:test-ns",
      JSON.stringify({ text: "✅ not-a-url · job-1\nBare repo" }),
    );
  });

  // processEvent with status other than done/failed does not notify
  it("does not notify when status is running", async () => {
    const event = makeEvent({ status: "running" });
    await coordinator.processEvent(event);
    expect(mockRedisPublish).not.toHaveBeenCalled();
  });

  it("does not notify when status is pending", async () => {
    const event = makeEvent({ status: "pending" });
    await coordinator.processEvent(event);
    expect(mockRedisPublish).not.toHaveBeenCalled();
  });

  // coordinatorPlan is ignored when status is failed (no spawn, but notifies)
  it("does not spawn next job when status is failed even if coordinatorPlan is set", async () => {
    const event = makeEvent({
      status: "failed",
      coordinatorPlan: { next_step: { repo_url: "https://github.com/x/y", task: "next" } },
    });
    await coordinator.processEvent(event);
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(mockRedisPublish).toHaveBeenCalledWith(
      "cca:notify:test-ns",
      expect.stringContaining("❌"),
    );
  });

  // stop() before start() is a no-op
  it("stop() before start() does not throw", async () => {
    const freshCoordinator = new Coordinator(makeManager() as any, "fresh-ns");
    await expect(freshCoordinator.stop()).resolves.toBeUndefined();
  });

  // start() when Redis is unavailable skips xgroup and still schedules poll
  it("start() when redis is null skips xgroup creation", async () => {
    // Use mockReturnValueOnce (NOT mockReturnValue) to avoid polluting subsequent tests.
    // start() calls getRedis() once for xgroup, then replayMissedEvents() calls it once more.
    mockGetRedis
      .mockReturnValueOnce(null) // for xgroup inside start()
      .mockReturnValueOnce(null); // for replayMissedEvents

    const freshCoordinator = new Coordinator(makeManager() as any, "no-redis-ns");
    await freshCoordinator.start();
    await freshCoordinator.stop();

    expect(mockRedisXgroup).not.toHaveBeenCalled();
  });

  // replayMissedEvents skips entries with empty fields array
  it("replayMissedEvents skips entries with empty fields (tombstoned entries)", async () => {
    // A stream entry with an empty fields array represents a deleted / tombstoned entry
    const tombstonedEntry: [string, string[]] = ["2-0", []];
    mockRedisXreadgroup
      .mockResolvedValueOnce([["cca:event-stream", [tombstonedEntry]]]) // replay with tombstone
      .mockResolvedValueOnce(null); // subsequent poll

    await coordinator.start();
    await coordinator.stop();

    // The tombstoned entry should have been skipped — spawn should not have been called
    expect(manager.spawn).not.toHaveBeenCalled();
    // xack should not have been called for tombstoned entries (they were skipped silently)
    expect(mockRedisXack).not.toHaveBeenCalledWith("cca:event-stream", "coordinator", "2-0");
  });

  // notify() when redis publish throws logs warning and does not throw
  it("notify() logs warning but does not throw when redis.publish rejects", async () => {
    mockRedisPublish.mockRejectedValueOnce(new Error("connection lost"));
    await expect(notify("test-ns", "some message")).resolves.toBeUndefined();
  });

  // notify() lpush operation after a publish failure still does not throw
  it("notify() with lpush failure does not throw", async () => {
    mockRedisLpush.mockRejectedValueOnce(new Error("OOM"));
    await expect(notify("test-ns", "msg")).resolves.toBeUndefined();
  });

  // repoUrl with only one path segment (no org/repo pair) uses full raw URL
  it("uses full URL when repoUrl has only one path segment (cannot form org/repo)", async () => {
    const event = makeEvent({
      status: "done",
      title: "One segment",
      repoUrl: "https://github.com/onlyone",
    });
    await coordinator.processEvent(event);

    // pathname is "/onlyone" → split gives ["onlyone"] → length < 2 → no org/repo pair
    // → falls back to the full original URL string
    expect(mockRedisPublish).toHaveBeenCalledWith(
      "cca:notify:test-ns",
      JSON.stringify({ text: "✅ https://github.com/onlyone · job-1\nOne segment" }),
    );
  });

  // title longer than 160 chars is truncated to 160 chars in notification
  it("truncates title to 160 characters in notification", async () => {
    const longTitle = "A".repeat(200);
    const event = makeEvent({ status: "done", title: longTitle, repoUrl: "https://github.com/x/y" });
    await coordinator.processEvent(event);

    const calls = mockRedisPublish.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const payload = JSON.parse(calls[0][1] as string) as { text: string };
    const lines = payload.text.split("\n");
    // Second line is the truncated title
    expect(lines[1].length).toBeLessThanOrEqual(160);
  });

  // spawnNext logs a warning when spawn rejects
  it("spawnNext logs warning when manager.spawn rejects on done event with coordinator plan", async () => {
    manager.spawn.mockRejectedValueOnce(new Error("docker failure"));
    const event = makeEvent({
      status: "done",
      coordinatorPlan: { next_step: { repo_url: "https://github.com/x/y", task: "task" } },
    });
    // Should not throw even when spawn rejects
    await expect(coordinator.processEvent(event)).resolves.toBeUndefined();
  });
});
