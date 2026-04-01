import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Coordinator, notify } from "./coordinator.js";
import type { JobEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockGetRedis, mockRedisPublish, mockRedisLpush, mockRedisLtrim, mockRedisGet, mockRedisSet, mockRedisXread } =
  vi.hoisted(() => {
    const mockRedisPublish = vi.fn(async () => 0);
    const mockRedisLpush = vi.fn(async () => 1);
    const mockRedisLtrim = vi.fn(async () => "OK" as string);
    const mockRedisGet = vi.fn(async () => null as string | null);
    const mockRedisSet = vi.fn(async () => "OK" as string);
    const mockRedisXread = vi.fn(async () => null as null | [string, [string, string[]][]][]);
    const mockRedisFull = {
      publish: mockRedisPublish,
      lpush: mockRedisLpush,
      ltrim: mockRedisLtrim,
      get: mockRedisGet,
      set: mockRedisSet,
      xread: mockRedisXread,
    };
    return {
      mockGetRedis: vi.fn(() => mockRedisFull as typeof mockRedisFull | null),
      mockRedisPublish,
      mockRedisLpush,
      mockRedisLtrim,
      mockRedisGet,
      mockRedisSet,
      mockRedisXread,
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
    timestamp: Date.now(),
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
    "timestamp", String(event.timestamp),
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

  it("publishes to channel and appends to log list", async () => {
    await notify("test-ns", "hello world");
    expect(mockRedisPublish).toHaveBeenCalledWith("cca:notify:test-ns", "hello world");
    expect(mockRedisLpush).toHaveBeenCalledWith("cca:notify-log:test-ns", "hello world");
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
    mockRedisXread.mockResolvedValueOnce([makeStreamEntry(event)]);
    mockRedisGet.mockResolvedValueOnce(null); // no prior last-id

    // Directly call poll via start (which calls replayMissedEvents → poll)
    await (coordinator as any).poll();

    expect(manager.spawn).toHaveBeenCalledWith({
      repoUrl: "https://github.com/test/child",
      task: "child task",
    });
  });

  // Test 3: Failed job triggers notification
  it("publishes failure notification on failed event", async () => {
    const event = makeEvent({ status: "failed", title: "My Job", repoUrl: "https://github.com/test/repo" });
    await coordinator.processEvent(event);

    expect(mockRedisPublish).toHaveBeenCalledWith(
      "cca:notify:test-ns",
      expect.stringContaining("failed"),
    );
    const call = mockRedisPublish.mock.calls.find((c) => c[0] === "cca:notify:test-ns");
    expect(call?.[1]).toContain("My Job");
  });

  // Test 4: Coordinator survives Redis error and continues processing
  it("logs error but continues when xread throws", async () => {
    mockRedisXread.mockRejectedValueOnce(new Error("connection lost"));
    // Should not throw
    await expect((coordinator as any).poll()).resolves.toBeUndefined();
  });

  it("logs error but continues when processEvent throws", async () => {
    manager.spawn.mockRejectedValueOnce(new Error("spawn failed"));
    const event = makeEvent({
      coordinatorPlan: { next_step: { repo_url: "https://github.com/x/y", task: "t" } },
    });
    mockRedisXread.mockResolvedValueOnce([makeStreamEntry(event)]);
    await expect((coordinator as any).poll()).resolves.toBeUndefined();
  });

  // Test 5: Missed events replayed on startup
  it("replays events written before coordinator starts", async () => {
    const events = [
      makeEvent({ jobId: "a", coordinatorPlan: { next_step: { repo_url: "https://github.com/r/a", task: "t1" } } }),
      makeEvent({ jobId: "b", status: "failed" }),
      makeEvent({ jobId: "c", status: "done", score: 0.3 }),
    ];

    // All three entries returned in one xread call
    const allEntries: [string, string[]][] = events.map((e, i) => {
      const fields: string[] = [
        "jobId", e.jobId,
        "status", e.status,
        "title", e.title,
        "repoUrl", e.repoUrl,
        "lastLines", "[]",
        "coordinatorPlan", JSON.stringify(e.coordinatorPlan ?? null),
        "score", e.score !== undefined ? String(e.score) : "",
        "timestamp", String(Date.now()),
      ];
      return [`${i + 1}-0`, fields];
    });

    mockRedisXread.mockResolvedValueOnce([["cca:event-stream", allEntries]]);
    mockRedisGet.mockResolvedValueOnce(null);

    await coordinator.start();
    await coordinator.stop();

    // Job "a" had a next_step so spawn should have been called
    expect(manager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: "https://github.com/r/a" }),
    );
    // Job "b" was failed → notification
    expect(mockRedisPublish).toHaveBeenCalledWith(
      "cca:notify:test-ns",
      expect.stringContaining("failed"),
    );
  });

  // Done event always notifies with ✓ format
  it("notifies ✓ done for a standard done event", async () => {
    const event = makeEvent({ status: "done", title: "My Task", repoUrl: "https://github.com/test/repo" });
    await coordinator.processEvent(event);

    expect(mockRedisPublish).toHaveBeenCalledWith(
      "cca:notify:test-ns",
      "✓ My Task done\nhttps://github.com/test/repo",
    );
  });

  // Done event with coordinatorPlan still notifies ✓ done (and spawns next)
  it("notifies ✓ done even when coordinatorPlan fires", async () => {
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
      "✓ Parent Task done\nhttps://github.com/test/repo",
    );
  });

  // Low score triggers notification
  it("publishes low-score notification when score < 0.5 on done event", async () => {
    const event = makeEvent({ status: "done", score: 0.3, title: "Low scorer" });
    await coordinator.processEvent(event);

    expect(mockRedisPublish).toHaveBeenCalledWith(
      "cca:notify:test-ns",
      expect.stringContaining("low score"),
    );
  });

  // All done jobs now notify
  it("publishes done notification for high-score done event", async () => {
    const event = makeEvent({ status: "done", score: 0.8, title: "Great Job", repoUrl: "https://github.com/test/repo" });
    await coordinator.processEvent(event);

    expect(mockRedisPublish).toHaveBeenCalledWith(
      "cca:notify:test-ns",
      "✓ Great Job done\nhttps://github.com/test/repo",
    );
  });
});
