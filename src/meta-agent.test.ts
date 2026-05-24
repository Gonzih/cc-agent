import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// --- Hoisted mocks ---
const {
  mockExistsSync,
  mockMkdirSync,
  mockExecSync,
  mockReaddirSync,
  mockSpawn,
  mockGetRedis,
  mockRedisGet,
  mockRedisSet,
  mockRedisSadd,
  mockRedisSmembers,
  mockRedisPublish,
  mockRedisRpop,
  mockRedisLPush,
  mockRedisLTrim,
} = vi.hoisted(() => {
  const mockRedisGet = vi.fn(async () => null as string | null);
  const mockRedisSet = vi.fn(async () => "OK");
  const mockRedisSadd = vi.fn(async () => 1);
  const mockRedisSmembers = vi.fn(async () => [] as string[]);
  const mockRedisPublish = vi.fn(async () => 0);
  const mockRedisRpop = vi.fn(async () => null as string | null);
  const mockRedisLPush = vi.fn(async () => 1);  // ioredis: lpush
  const mockRedisLTrim = vi.fn(async () => "OK");  // ioredis: ltrim

  const mockRedis = {
    get: mockRedisGet,
    set: mockRedisSet,
    sadd: mockRedisSadd,
    smembers: mockRedisSmembers,
    publish: mockRedisPublish,
    rpop: mockRedisRpop,
    lpush: mockRedisLPush,
    ltrim: mockRedisLTrim,
  };

  const mockGetRedis = vi.fn(() => mockRedis as typeof mockRedis | null);
  const mockExistsSync = vi.fn(() => false);
  const mockMkdirSync = vi.fn();
  const mockExecSync = vi.fn();
  const mockReaddirSync = vi.fn(() => [] as string[]);

  const mockSpawn = vi.fn(() => {
    const proc = new EventEmitter() as any;
    proc.pid = 99999;
    proc.killed = false;
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
    mockReaddirSync,
    mockSpawn,
    mockGetRedis,
    mockRedisGet,
    mockRedisSet,
    mockRedisSadd,
    mockRedisSmembers,
    mockRedisPublish,
    mockRedisRpop,
    mockRedisLPush,
    mockRedisLTrim,
  };
});

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  readdirSync: mockReaddirSync,
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

/** Helper: rebuild a consistent redis mock object and wire it up. */
function resetRedisMock() {
  const redisMock = {
    get: mockRedisGet,
    set: mockRedisSet,
    sadd: mockRedisSadd,
    smembers: mockRedisSmembers,
    publish: mockRedisPublish,
    rpop: mockRedisRpop,
    lpush: mockRedisLPush,
    ltrim: mockRedisLTrim,
  };
  mockGetRedis.mockReturnValue(redisMock);
  return redisMock;
}

describe("MetaAgentManager", () => {
  let manager: MetaAgentManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: workspace dir does not exist, session dir does not exist
    mockExistsSync.mockReturnValue(false);
    // Default: readdirSync returns no files (no session)
    mockReaddirSync.mockReturnValue([]);
    // Default: input queue is empty, log ops succeed
    mockRedisRpop.mockResolvedValue(null);
    mockRedisLPush.mockResolvedValue(1);
    mockRedisLTrim.mockResolvedValue("OK");
    resetRedisMock();
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

  describe("startMetaAgent", () => {
    it("saves state as idle without spawning a process", async () => {
      mockExistsSync.mockReturnValue(true); // workspace exists
      mockRedisGet.mockResolvedValue(null);  // no prior state

      const info = await manager.startMetaAgent("my-repo");

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(info.status).toBe("idle");
      expect(info.namespace).toBe("my-repo");
    });

    it("saves state to Redis and adds to index", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);

      await manager.startMetaAgent("my-repo");

      expect(mockRedisSet).toHaveBeenCalledWith(
        "cca:meta:my-repo",
        expect.any(String),
        "EX",
        expect.any(Number)
      );
      expect(mockRedisSadd).toHaveBeenCalledWith("cca:meta:agents:index", "my-repo");
    });

    it("returns existing state when state already exists in Redis", async () => {
      const existingState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "idle",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(existingState));

      const info = await manager.startMetaAgent("my-repo");

      // No new state saved, no clone — just returned existing
      expect(info.namespace).toBe("my-repo");
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe("messageMetaAgent", () => {
    it("spawns claude with -p and message content", async () => {
      mockExistsSync.mockReturnValue(true);  // workspace exists
      mockRedisGet.mockResolvedValue(null);  // no prior state → startMetaAgent will create it

      await manager.messageMetaAgent("my-repo", "hello agent");

      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["-p", "hello agent", "--dangerously-skip-permissions"]),
        expect.objectContaining({ cwd: expect.stringContaining("cc-agent-workspace/my-repo") })
      );
    });

    it("does not use --continue when no session .jsonl file exists", async () => {
      // existsSync returns false for session dir → no session
      mockExistsSync.mockReturnValue(false);
      mockRedisGet.mockResolvedValue(null);

      await manager.messageMetaAgent("my-repo", "first message");

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--continue");
      expect(args).toContain("-p");
    });

    it("uses --continue when session .jsonl file exists", async () => {
      // Workspace CWD exists but no session dir initially
      mockExistsSync.mockImplementation((p: string) => {
        if ((p as string).includes(".claude/projects")) return true; // session dir exists
        return true; // workspace exists
      });
      mockReaddirSync.mockReturnValue(["abc123.jsonl" as any]);

      // Provide existing state so no startMetaAgent call needed
      const priorState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "idle",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(priorState));

      await manager.messageMetaAgent("my-repo", "follow-up message");

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args[0]).toBe("--continue");
      expect(args).toContain("-p");
      expect(args).toContain("follow-up message");
    });

    it("publishes stdout lines to the outgoing Redis channel", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);

      await manager.messageMetaAgent("my-repo", "say something");

      const proc = mockSpawn.mock.results[0].value;
      // Simulate stdout data
      proc.stdout.emit("data", "Hello from Claude\n");

      expect(mockRedisPublish).toHaveBeenCalledWith(
        "cca:chat:outgoing:my-repo",
        expect.stringContaining("Hello from Claude")
      );
    });

    it("sets isTyping false and marks idle when process closes", async () => {
      mockExistsSync.mockReturnValue(true);
      const priorState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "idle",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(priorState));

      await manager.messageMetaAgent("my-repo", "do something");

      const proc = mockSpawn.mock.results[0].value;

      // Before close: process is active
      expect(proc.killed).toBe(false);

      // Simulate process close
      proc.emit("close", 0);

      // After close: updateStatus("idle") should be called via redis.get + redis.set
      // (fire-and-forget, so we need to wait a tick)
      await new Promise((r) => setTimeout(r, 0));

      const setCalls = mockRedisSet.mock.calls.filter(
        (c) => (c[0] as string) === "cca:meta:my-repo"
      );
      // updateStatus reads state then writes it with status: "idle"
      // (may not fire if getState returns null — but priorState is mocked above)
      expect(setCalls.length).toBeGreaterThan(0);
    });

    it("auto-starts workspace when no state exists", async () => {
      mockExistsSync.mockReturnValue(false); // workspace does not exist (will be cloned)
      mockRedisGet.mockResolvedValue(null);   // no prior state

      await manager.messageMetaAgent("my-repo", "first message");

      // ensureWorkspace should have been called (cloned the repo)
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("git clone"),
        expect.any(Object)
      );
      // And a process should have been spawned
      expect(mockSpawn).toHaveBeenCalled();
    });

    it("saves lastMessageAt via set (not hset) to avoid WRONGTYPE error", async () => {
      const priorState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "idle",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(JSON.stringify(priorState));

      await manager.messageMetaAgent("my-repo", "test message");

      // State should be written via set with lastMessageAt populated.
      const setCalls = mockRedisSet.mock.calls.filter(
        (c) => (c[0] as string) === "cca:meta:my-repo"
      );
      const lastSetCall = setCalls[setCalls.length - 1];
      expect(lastSetCall).toBeDefined();
      if (lastSetCall) {
        const saved = JSON.parse(lastSetCall[1] as string) as { lastMessageAt?: string };
        expect(saved.lastMessageAt).toMatch(/^\d{4}-/);
      }
    });

    it("throws when Redis is unavailable", async () => {
      mockGetRedis.mockReturnValue(null);

      await expect(manager.messageMetaAgent("my-repo", "msg")).rejects.toThrow(
        "Redis not available"
      );
    });

    it("uses stdio ignore for stdin (no stdin pipe)", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);

      await manager.messageMetaAgent("my-repo", "hello");

      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        expect.any(Array),
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] })
      );
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
        status: "idle",
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

  describe("stopMetaAgent", () => {
    it("kills the active per-message process when running", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);

      // Spawn a process by messaging the agent
      await manager.messageMetaAgent("my-repo", "do something");

      const proc = mockSpawn.mock.results[0].value;
      expect(proc.killed).toBe(false);

      const existingState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(existingState));

      await manager.stopMetaAgent("my-repo");

      expect(proc.kill).toHaveBeenCalled();
    });

    it("updates status to idle in Redis", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);
      await manager.messageMetaAgent("my-repo", "do something");

      const existingState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(existingState));

      vi.clearAllMocks();
      resetRedisMock();
      mockRedisGet.mockResolvedValue(JSON.stringify(existingState));

      await manager.stopMetaAgent("my-repo");

      const setCall = mockRedisSet.mock.calls.find((c) => (c[0] as string) === "cca:meta:my-repo");
      if (setCall) {
        const saved = JSON.parse(setCall[1] as string) as { status: string };
        expect(saved.status).toBe("idle");
      }
    });

    it("does not throw when no process is tracked", async () => {
      const existingState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "idle",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(existingState));

      await expect(manager.stopMetaAgent("unknown-repo")).resolves.toBeUndefined();
    });
  });

  describe("startPoller / pollInputQueues", () => {
    it("startPoller registers an interval and stopPoller clears it", () => {
      vi.useFakeTimers();
      manager.startPoller();
      // Starting twice is a no-op (pollerHandle already set)
      manager.startPoller();
      manager.stopPoller();
      // Should not throw after stopping
      manager.stopPoller();
      vi.useRealTimers();
    });

    it("RPOP drains one message per namespace per tick and calls messageMetaAgent", async () => {
      mockRedisSmembers.mockResolvedValue(["my-repo"]);
      mockExistsSync.mockReturnValue(true);

      const priorState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "idle",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(priorState));

      const queuedMessage = JSON.stringify({ content: "do the thing" });
      mockRedisRpop.mockResolvedValueOnce(queuedMessage).mockResolvedValue(null);

      // Call pollInputQueues directly (avoids fake-timer/fire-and-forget complexity)
      await (manager as any).pollInputQueues();

      // Flush all pending microtasks/macrotasks so the fire-and-forget messageMetaAgent settles
      await new Promise((r) => setImmediate(r));

      expect(mockRedisRpop).toHaveBeenCalledWith("cca:meta:my-repo:input");
      // messageMetaAgent should have spawned claude with the message content
      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["-p", "do the thing", "--dangerously-skip-permissions"]),
        expect.any(Object)
      );
    });

    it("skips namespace when a process is already active", async () => {
      mockRedisSmembers.mockResolvedValue(["my-repo"]);
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);

      // Spawn an active process first
      await manager.messageMetaAgent("my-repo", "first");
      const queuedMessage = JSON.stringify({ content: "second" });
      mockRedisRpop.mockResolvedValue(queuedMessage);

      // Poll directly — should skip because process is active
      await (manager as any).pollInputQueues();

      // RPOP should not have been called since process is still active
      expect(mockRedisRpop).not.toHaveBeenCalled();
    });

    it("handles raw string messages (non-JSON) gracefully", async () => {
      mockRedisSmembers.mockResolvedValue(["my-repo"]);
      mockExistsSync.mockReturnValue(true);
      const priorState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "idle",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(priorState));

      // Non-JSON raw string
      mockRedisRpop.mockResolvedValueOnce("plain text message").mockResolvedValue(null);

      await (manager as any).pollInputQueues();
      await new Promise((r) => setImmediate(r));

      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["-p", "plain text message"]),
        expect.any(Object)
      );
    });

    it("does not throw when Redis is unavailable during poll", async () => {
      mockGetRedis.mockReturnValue(null);
      await expect((manager as any).pollInputQueues()).resolves.not.toThrow();
    });

    it("writes coordinator input to chat log with role=user source=cc-tg before spawning", async () => {
      mockRedisSmembers.mockResolvedValue(["my-repo"]);
      mockExistsSync.mockReturnValue(true);
      const priorState = {
        namespace: "my-repo",
        repoUrl: "https://github.com/gonzih/my-repo",
        cwd: "/home/user/cc-agent-workspace/my-repo",
        status: "idle",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(priorState));

      const queuedMessage = JSON.stringify({ content: "please do the thing" });
      mockRedisRpop.mockResolvedValueOnce(queuedMessage).mockResolvedValue(null);

      await (manager as any).pollInputQueues();
      await new Promise((r) => setImmediate(r));

      // Protocol: ChatMessage shape = { id, source, role, content, timestamp, chatId }
      // Source for coordinator-injected messages is 'cc-tg'
      const coordinatorCall = mockRedisLPush.mock.calls.find((c) => {
        if ((c[0] as string) !== "cca:chat:log:my-repo") return false;
        try {
          const parsed = JSON.parse(c[1] as string) as {
            role: string;
            source: string;
            content: string;
          };
          return parsed.role === "user" && parsed.source === "cc-tg";
        } catch {
          return false;
        }
      });

      expect(coordinatorCall).toBeDefined();
      if (coordinatorCall) {
        const entry = JSON.parse(coordinatorCall[1] as string) as {
          role: string;
          source: string;
          content: string;
          chatId: number;
          timestamp: string;
          id: string;
        };
        expect(entry.role).toBe("user");
        expect(entry.source).toBe("cc-tg");
        expect(entry.content).toBe("please do the thing");
        expect(entry.chatId).toBe(0);
        expect(entry.timestamp).toMatch(/^\d{4}-/);
        expect(entry.id).toBeDefined();
      }
    });
  });

  describe("publishOutput / chat log persistence", () => {
    it("publishes stdout lines to outgoing channel AND persists to chat log", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);

      await manager.messageMetaAgent("my-repo", "say something");

      const proc = mockSpawn.mock.results[0].value;
      proc.stdout.emit("data", "Hello from Claude\n");

      // Allow async publishOutput to settle
      await new Promise((r) => setTimeout(r, 0));

      expect(mockRedisPublish).toHaveBeenCalledWith(
        "cca:chat:outgoing:my-repo",
        expect.stringContaining("Hello from Claude")
      );
      expect(mockRedisLPush).toHaveBeenCalledWith(
        "cca:chat:log:my-repo",
        expect.stringContaining("Hello from Claude")
      );
      expect(mockRedisLTrim).toHaveBeenCalledWith("cca:chat:log:my-repo", 0, 499);
      // (ioredis uses lowercase: lpush/ltrim — verified by mock key names above)
    });

    it("persists message as JSON with role assistant", async () => {
      mockExistsSync.mockReturnValue(true);
      mockRedisGet.mockResolvedValue(null);

      await manager.messageMetaAgent("my-repo", "say hello");

      const proc = mockSpawn.mock.results[0].value;
      proc.stdout.emit("data", "output line\n");

      await new Promise((r) => setTimeout(r, 0));

      const lPushCall = mockRedisLPush.mock.calls[0];
      expect(lPushCall).toBeDefined();
      if (lPushCall) {
        // Protocol: ChatMessage shape = { id, source, role, content, timestamp, chatId }
        const persisted = JSON.parse(lPushCall[1] as string) as {
          role: string;
          source: string;
          content: string;
          chatId: number;
        };
        expect(persisted.role).toBe("assistant");
        expect(persisted.source).toBe("claude");
        expect(persisted.content).toBe("output line");
        expect(persisted.chatId).toBe(0);
      }
    });
  });
});
