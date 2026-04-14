import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// --- Hoisted mocks ---
const {
  mockExistsSync,
  mockMkdirSync,
  mockExecSync,
  mockSpawn,
  mockGetRedis,
  mockRedisLpush,
  mockRedisRpop,
  mockRedisGet,
  mockRedisSet,
  mockRedisSadd,
  mockRedisSmembers,
  mockRedisHset,
  mockRedisPublish,
} = vi.hoisted(() => {
  const mockRedisLpush = vi.fn(async () => 1);
  const mockRedisRpop = vi.fn(async () => null as string | null);
  const mockRedisGet = vi.fn(async () => null as string | null);
  const mockRedisSet = vi.fn(async () => "OK");
  const mockRedisSadd = vi.fn(async () => 1);
  const mockRedisSmembers = vi.fn(async () => [] as string[]);
  const mockRedisHset = vi.fn(async () => 1);
  const mockRedisPublish = vi.fn(async () => 0);

  const mockRedis = {
    lpush: mockRedisLpush,
    rpop: mockRedisRpop,
    get: mockRedisGet,
    set: mockRedisSet,
    sadd: mockRedisSadd,
    smembers: mockRedisSmembers,
    hset: mockRedisHset,
    publish: mockRedisPublish,
  };

  const mockGetRedis = vi.fn(() => mockRedis as typeof mockRedis | null);
  const mockExistsSync = vi.fn(() => false);
  const mockMkdirSync = vi.fn();
  const mockExecSync = vi.fn();

  const mockSpawn = vi.fn(() => {
    const proc = new EventEmitter() as any;
    proc.pid = 99999;
    proc.killed = false;
    const stdinEmitter = new EventEmitter() as any;
    stdinEmitter.destroyed = false;
    stdinEmitter.write = vi.fn();
    proc.stdin = stdinEmitter;
    const stdoutEmitter = new EventEmitter() as any;
    stdoutEmitter.setEncoding = vi.fn();
    proc.stdout = stdoutEmitter;
    const stderrEmitter = new EventEmitter() as any;
    stderrEmitter.setEncoding = vi.fn();
    proc.stderr = stderrEmitter;
    proc.kill = vi.fn(() => { proc.killed = true; });
    return proc;
  });

  return {
    mockExistsSync,
    mockMkdirSync,
    mockExecSync,
    mockSpawn,
    mockGetRedis,
    mockRedisLpush,
    mockRedisRpop,
    mockRedisGet,
    mockRedisSet,
    mockRedisSadd,
    mockRedisSmembers,
    mockRedisHset,
    mockRedisPublish,
  };
});

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
}));

vi.mock("child_process", () => ({
  spawn: mockSpawn,
  execSync: mockExecSync,
}));

vi.mock("./redis.js", () => ({
  getRedis: mockGetRedis,
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks are set up
import { MetaAgentManager } from "./meta-agent.js";

describe("MetaAgentManager", () => {
  let manager: MetaAgentManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: directory does not exist
    mockExistsSync.mockReturnValue(false);
    // Default: Redis is available
    mockGetRedis.mockReturnValue({
      lpush: mockRedisLpush,
      rpop: mockRedisRpop,
      get: mockRedisGet,
      set: mockRedisSet,
      sadd: mockRedisSadd,
      smembers: mockRedisSmembers,
      hset: mockRedisHset,
      publish: mockRedisPublish,
    });
    manager = new MetaAgentManager();
  });

  describe("ensureWorkspace", () => {
    it("clones repo when directory does not exist", async () => {
      mockExistsSync.mockReturnValue(false);

      const cwd = await manager.ensureWorkspace("my-repo");

      expect(cwd).toContain("cc-agent-workspace/my-repo");
      expect(mockMkdirSync).toHaveBeenCalled();
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("git clone"),
        expect.any(Object)
      );
    });

    it("uses provided repoUrl for clone", async () => {
      mockExistsSync.mockReturnValue(false);

      await manager.ensureWorkspace("my-repo", "https://github.com/custom/my-repo");

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("https://github.com/custom/my-repo"),
        expect.any(Object)
      );
    });

    it("skips clone when directory already exists", async () => {
      mockExistsSync.mockReturnValue(true);

      await manager.ensureWorkspace("existing-repo");

      expect(mockExecSync).not.toHaveBeenCalled();
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it("defaults to gonzih/{namespace} URL", async () => {
      mockExistsSync.mockReturnValue(false);

      await manager.ensureWorkspace("cool-project");

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("gonzih/cool-project"),
        expect.any(Object)
      );
    });
  });

  describe("messageMetaAgent", () => {
    it("lpushes to cca:meta:{namespace}:input", async () => {
      await manager.messageMetaAgent("my-repo", "hello agent");

      expect(mockRedisLpush).toHaveBeenCalledWith(
        "cca:meta:my-repo:input",
        expect.any(String)
      );
    });

    it("the queued entry contains the message content", async () => {
      await manager.messageMetaAgent("my-repo", "do a thing");

      const call = mockRedisLpush.mock.calls[0];
      const entry = JSON.parse(call[1] as string) as { content: string };
      expect(entry.content).toBe("do a thing");
    });

    it("updates lastMessageAt in Redis", async () => {
      await manager.messageMetaAgent("my-repo", "test message");

      expect(mockRedisHset).toHaveBeenCalledWith(
        "cca:meta:my-repo",
        "lastMessageAt",
        expect.any(String)
      );
    });

    it("throws when Redis is unavailable", async () => {
      mockGetRedis.mockReturnValue(null);

      await expect(manager.messageMetaAgent("my-repo", "msg")).rejects.toThrow(
        "Redis not available"
      );
    });

    it("auto-starts the agent if not running before enqueuing", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);

      // No prior startMetaAgent call — no running process in the map
      await manager.messageMetaAgent("my-repo", "hello agent");

      // Should have spawned a new process (no prior state → no --continue)
      expect(mockSpawn).toHaveBeenCalledWith("claude", [], expect.any(Object));
      // And still enqueued the message
      expect(mockRedisLpush).toHaveBeenCalledWith(
        "cca:meta:my-repo:input",
        expect.any(String)
      );
    });

    it("does not re-start if agent is already running", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);

      // Start once explicitly
      await manager.startMetaAgent("my-repo");
      const spawnCount = mockSpawn.mock.calls.length;

      // Message should not trigger another spawn
      await manager.messageMetaAgent("my-repo", "second message");
      expect(mockSpawn.mock.calls.length).toBe(spawnCount);
    });
  });

  describe("listMetaAgents", () => {
    it("returns empty array when no agents exist", async () => {
      mockRedisSmembers.mockResolvedValue([]);

      const result = await manager.listMetaAgents();

      expect(result).toEqual([]);
    });

    it("returns parsed state from Redis smembers", async () => {
      const state = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        pid: 1234,
        status: "stopped",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisSmembers.mockResolvedValue(["my-repo"]);
      mockRedisGet.mockResolvedValue(JSON.stringify(state));

      const result = await manager.listMetaAgents();

      expect(result).toHaveLength(1);
      expect(result[0].namespace).toBe("my-repo");
      expect(result[0].repoUrl).toBe("https://github.com/gonzih/my-repo");
    });

    it("returns empty array when Redis is unavailable", async () => {
      mockGetRedis.mockReturnValue(null);

      const result = await manager.listMetaAgents();

      expect(result).toEqual([]);
    });

    it("queries the agents index key", async () => {
      mockRedisSmembers.mockResolvedValue([]);

      await manager.listMetaAgents();

      expect(mockRedisSmembers).toHaveBeenCalledWith("cca:meta:agents:index");
    });
  });

  describe("startMetaAgent", () => {
    it("spawns claude without --continue when no prior session exists", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null); // no prior state → first-time start

      await manager.startMetaAgent("my-repo");

      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        [], // no --continue on fresh start
        expect.objectContaining({
          cwd: expect.stringContaining("cc-agent-workspace/my-repo"),
        })
      );
    });

    it("writes initial system prompt to stdin when starting fresh", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);

      await manager.startMetaAgent("my-repo");

      const proc = mockSpawn.mock.results[0].value;
      expect(proc.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining("persistent meta-agent")
      );
    });

    it("spawns claude with --continue when prior session exists", async () => {
      mockExistsSync.mockReturnValue(true);
      const priorState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "stopped",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(priorState));

      await manager.startMetaAgent("my-repo");

      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        ["--continue"],
        expect.any(Object)
      );
    });

    it("does not write initial prompt when resuming a prior session", async () => {
      mockExistsSync.mockReturnValue(true);
      const priorState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "stopped",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(priorState));

      await manager.startMetaAgent("my-repo");

      const proc = mockSpawn.mock.results[0].value;
      expect(proc.stdin.write).not.toHaveBeenCalledWith(
        expect.stringContaining("persistent meta-agent")
      );
    });

    it("saves state to Redis and adds to index", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);

      const info = await manager.startMetaAgent("my-repo");

      expect(mockRedisSet).toHaveBeenCalledWith(
        "cca:meta:my-repo",
        expect.any(String),
        "EX",
        expect.any(Number)
      );
      expect(mockRedisSadd).toHaveBeenCalledWith("cca:meta:agents:index", "my-repo");
      expect(info.namespace).toBe("my-repo");
      expect(info.status).toBe("running");
    });

    it("returns existing state when agent is already running", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);

      // Start once
      await manager.startMetaAgent("my-repo");

      // Set up existing state for second call
      const existingState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(existingState));

      // Second call should not spawn a new process
      const spawnCallCount = mockSpawn.mock.calls.length;
      await manager.startMetaAgent("my-repo");

      expect(mockSpawn.mock.calls.length).toBe(spawnCallCount);
    });
  });

  describe("stopMetaAgent", () => {
    it("kills the process when it is running", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);

      await manager.startMetaAgent("my-repo");

      const existingState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(existingState));

      await manager.stopMetaAgent("my-repo");

      const proc = mockSpawn.mock.results[0].value;
      expect(proc.kill).toHaveBeenCalled();
    });

    it("updates status to stopped in Redis", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);
      await manager.startMetaAgent("my-repo");

      const existingState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(existingState));

      vi.clearAllMocks();
      mockGetRedis.mockReturnValue({
        lpush: mockRedisLpush,
        rpop: mockRedisRpop,
        get: mockRedisGet,
        set: mockRedisSet,
        sadd: mockRedisSadd,
        smembers: mockRedisSmembers,
        hset: mockRedisHset,
        publish: mockRedisPublish,
      });
      mockRedisGet.mockResolvedValue(JSON.stringify(existingState));

      await manager.stopMetaAgent("my-repo");

      const setCall = mockRedisSet.mock.calls.find((c) => (c[0] as string) === "cca:meta:my-repo");
      if (setCall) {
        const saved = JSON.parse(setCall[1] as string) as { status: string };
        expect(saved.status).toBe("stopped");
      }
    });

    it("does not throw when no process is tracked", async () => {
      const existingState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(existingState));

      // Should not throw even when no process is in the map
      await expect(manager.stopMetaAgent("unknown-repo")).resolves.toBeUndefined();
    });
  });
});
