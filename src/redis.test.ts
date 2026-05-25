import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so these variables are available inside the vi.mock() factory closures.
const { mockConnect, mockPing, mockOn, MockRedisClass, mockExecFileRaw } = vi.hoisted(() => {
  const mockConnect = vi.fn();
  const mockPing = vi.fn();
  const mockOn = vi.fn();
  // Must use a regular function (not arrow) so it can be called with `new`
  const MockRedisClass = vi.fn(function MockRedis() {
    return { connect: mockConnect, ping: mockPing, on: mockOn };
  });
  const mockExecFileRaw = vi.fn();
  return { mockConnect, mockPing, mockOn, MockRedisClass, mockExecFileRaw };
});

vi.mock("ioredis", () => ({ Redis: MockRedisClass }));

// execFile is used through promisify — the mock must be callback-style
vi.mock("child_process", () => ({
  execFile: mockExecFileRaw,
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Re-setup MockRedisClass after each vi.clearAllMocks() (which clears call history but not impl)
// Must use a regular function (not arrow) so `new MockRedisClass()` works properly
function setupMockRedis() {
  MockRedisClass.mockImplementation(function MockRedis() {
    return { connect: mockConnect, ping: mockPing, on: mockOn };
  });
}

describe("getRedis (before initRedis)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    setupMockRedis();
  });

  it("returns null before initRedis has been called", async () => {
    const { getRedis } = await import("./redis.js");
    expect(getRedis()).toBeNull();
  });
});

describe("initRedis — direct connection success", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    setupMockRedis();
  });

  it("sets the redis client on successful first-try connection", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockPing.mockResolvedValue("PONG");
    mockOn.mockReturnValue(undefined);

    const { initRedis, getRedis } = await import("./redis.js");
    await initRedis();

    expect(getRedis()).not.toBeNull();
    expect(mockConnect).toHaveBeenCalled();
    expect(mockPing).toHaveBeenCalled();
  });

  it("creates Redis with REDIS_DB env var as db number", async () => {
    process.env.REDIS_DB = "3";
    mockConnect.mockResolvedValue(undefined);
    mockPing.mockResolvedValue("PONG");
    mockOn.mockReturnValue(undefined);

    const { initRedis } = await import("./redis.js");
    await initRedis();

    const ctorCall = MockRedisClass.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(ctorCall?.db).toBe(3);

    delete process.env.REDIS_DB;
  });

  it("defaults to db 0 when REDIS_DB is not set", async () => {
    delete process.env.REDIS_DB;
    mockConnect.mockResolvedValue(undefined);
    mockPing.mockResolvedValue("PONG");
    mockOn.mockReturnValue(undefined);

    const { initRedis } = await import("./redis.js");
    await initRedis();

    const ctorCall = MockRedisClass.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(ctorCall?.db).toBe(0);
  });

  it("getRedis returns same client on repeated calls", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockPing.mockResolvedValue("PONG");
    mockOn.mockReturnValue(undefined);

    const { initRedis, getRedis } = await import("./redis.js");
    await initRedis();

    expect(getRedis()).toBe(getRedis());
    expect(getRedis()).not.toBeNull();
  });
});

describe("initRedis — all fallbacks fail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    setupMockRedis();
  });

  it("leaves client null when direct connect, Docker, and daemon all fail", async () => {
    // Direct connection fails (only 1 attempt, no sleep since attempts=1)
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));
    mockOn.mockReturnValue(undefined);

    // All execFile calls fail (docker run fails → docker start fails → which redis-server fails)
    // This means tryDocker() and tryRedisDaemon() both return false, so tryConnect(10, 500) is never called
    mockExecFileRaw.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(new Error("command not found"), "", "");
      }
    );

    const { initRedis, getRedis } = await import("./redis.js");
    await initRedis();

    expect(getRedis()).toBeNull();
  });
});
