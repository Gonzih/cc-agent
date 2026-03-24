import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock Redis ──────────────────────────────────────────────────────────────

const mockRedisStore = new Map<string, string>();
const mockRedis = {
  get: vi.fn(async (key: string) => mockRedisStore.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => { mockRedisStore.set(key, value); return "OK"; }),
  incr: vi.fn(async (key: string) => {
    const current = parseInt(mockRedisStore.get(key) ?? "0", 10);
    const next = current + 1;
    mockRedisStore.set(key, String(next));
    return next;
  }),
  del: vi.fn(async (key: string) => { mockRedisStore.delete(key); return 1; }),
};

vi.mock("./redis.js", () => ({
  getRedis: vi.fn(() => mockRedis),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import after mocks are set up
import { loadTokens, getCurrentToken, rotateToken, getTokenStatus, resetTokens } from "./tokens.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  mockRedisStore.clear();
  vi.clearAllMocks();
  delete process.env.CLAUDE_TOKENS;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

// ─── loadTokens ──────────────────────────────────────────────────────────────

describe("loadTokens", () => {
  it("returns empty array when no env vars set", () => {
    expect(loadTokens()).toEqual([]);
  });

  it("falls back to CLAUDE_CODE_OAUTH_TOKEN single token", () => {
    setEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-single" });
    expect(loadTokens()).toEqual(["sk-ant-single"]);
  });

  it("parses CLAUDE_TOKENS comma-separated list", () => {
    setEnv({ CLAUDE_TOKENS: "tok-a,tok-b,tok-c" });
    expect(loadTokens()).toEqual(["tok-a", "tok-b", "tok-c"]);
  });

  it("trims whitespace from CLAUDE_TOKENS entries", () => {
    setEnv({ CLAUDE_TOKENS: " tok-a , tok-b " });
    expect(loadTokens()).toEqual(["tok-a", "tok-b"]);
  });

  it("prefers CLAUDE_TOKENS over CLAUDE_CODE_OAUTH_TOKEN", () => {
    setEnv({ CLAUDE_TOKENS: "tok-multi", CLAUDE_CODE_OAUTH_TOKEN: "tok-single" });
    expect(loadTokens()).toEqual(["tok-multi"]);
  });

  it("falls back to CLAUDE_CODE_OAUTH_TOKEN if CLAUDE_TOKENS is empty string", () => {
    setEnv({ CLAUDE_TOKENS: "  ", CLAUDE_CODE_OAUTH_TOKEN: "tok-fallback" });
    expect(loadTokens()).toEqual(["tok-fallback"]);
  });
});

// ─── getCurrentToken ─────────────────────────────────────────────────────────

describe("getCurrentToken", () => {
  it("returns empty string when no tokens", async () => {
    expect(await getCurrentToken()).toBe("");
  });

  it("returns single token without Redis lookup", async () => {
    setEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-only" });
    expect(await getCurrentToken()).toBe("sk-ant-only");
    // Single-token path skips Redis
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it("returns first token when counter is 0", async () => {
    setEnv({ CLAUDE_TOKENS: "tok-a,tok-b,tok-c" });
    expect(await getCurrentToken()).toBe("tok-a");
  });

  it("returns token at current index from Redis", async () => {
    setEnv({ CLAUDE_TOKENS: "tok-a,tok-b,tok-c" });
    mockRedisStore.set("cca:token:index", "1");
    expect(await getCurrentToken()).toBe("tok-b");
  });

  it("wraps around when index exceeds token count", async () => {
    setEnv({ CLAUDE_TOKENS: "tok-a,tok-b" });
    mockRedisStore.set("cca:token:index", "3"); // 3 % 2 = 1 → tok-b
    expect(await getCurrentToken()).toBe("tok-b");
  });
});

// ─── rotateToken ─────────────────────────────────────────────────────────────

describe("rotateToken", () => {
  it("returns single token without incrementing Redis", async () => {
    setEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-only" });
    const tok = await rotateToken();
    expect(tok).toBe("sk-ant-only");
    expect(mockRedis.incr).not.toHaveBeenCalled();
  });

  it("increments index and returns next token", async () => {
    setEnv({ CLAUDE_TOKENS: "tok-a,tok-b,tok-c" });
    const tok = await rotateToken();
    expect(tok).toBe("tok-b"); // counter 0→1, index 1 % 3 = 1
    expect(mockRedisStore.get("cca:token:index")).toBe("1");
  });

  it("wraps around after last token", async () => {
    setEnv({ CLAUDE_TOKENS: "tok-a,tok-b" });
    mockRedisStore.set("cca:token:index", "1"); // counter is 1
    const tok = await rotateToken(); // incr → 2, 2 % 2 = 0
    expect(tok).toBe("tok-a");
  });

  it("multi-rotation through all tokens returns to start", async () => {
    setEnv({ CLAUDE_TOKENS: "tok-a,tok-b,tok-c" });
    await rotateToken(); // tok-b
    await rotateToken(); // tok-c
    const tok = await rotateToken(); // tok-a (wrap)
    expect(tok).toBe("tok-a");
  });
});

// ─── getTokenStatus ──────────────────────────────────────────────────────────

describe("getTokenStatus", () => {
  it("reports allExhausted=true when no tokens configured", async () => {
    const s = await getTokenStatus();
    expect(s).toEqual({ index: 0, total: 0, allExhausted: true });
  });

  it("reports not exhausted at counter 0", async () => {
    setEnv({ CLAUDE_TOKENS: "tok-a,tok-b,tok-c" });
    const s = await getTokenStatus();
    expect(s.total).toBe(3);
    expect(s.index).toBe(0);
    expect(s.allExhausted).toBe(false);
  });

  it("reports not exhausted while rotating through tokens", async () => {
    setEnv({ CLAUDE_TOKENS: "tok-a,tok-b,tok-c" });
    mockRedisStore.set("cca:token:index", "2"); // counter 2 < total 3
    const s = await getTokenStatus();
    expect(s.allExhausted).toBe(false);
    expect(s.index).toBe(2);
  });

  it("reports allExhausted=true when counter >= total", async () => {
    setEnv({ CLAUDE_TOKENS: "tok-a,tok-b,tok-c" });
    mockRedisStore.set("cca:token:index", "3"); // counter 3 >= total 3
    const s = await getTokenStatus();
    expect(s.allExhausted).toBe(true);
  });
});

// ─── resetTokens ─────────────────────────────────────────────────────────────

describe("resetTokens", () => {
  it("deletes the token index key from Redis", async () => {
    setEnv({ CLAUDE_TOKENS: "tok-a,tok-b,tok-c" });
    mockRedisStore.set("cca:token:index", "3");
    await resetTokens();
    expect(mockRedisStore.has("cca:token:index")).toBe(false);
    expect(mockRedis.del).toHaveBeenCalledWith("cca:token:index");
  });

  it("after reset, getCurrentToken returns first token again", async () => {
    setEnv({ CLAUDE_TOKENS: "tok-a,tok-b,tok-c" });
    mockRedisStore.set("cca:token:index", "2");
    await resetTokens();
    expect(await getCurrentToken()).toBe("tok-a");
  });
});
