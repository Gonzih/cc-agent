/**
 * wiki.test.ts
 *
 * Tests WikiStore using a hoisted mock Redis so tests run without a Redis server.
 * Covers in-memory fallback (Redis returns null) and Redis paths.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockGetRedis, mockRedis } = vi.hoisted(() => {
  const mockRedis = {
    hset: vi.fn(),
    hget: vi.fn(),
    hkeys: vi.fn(),
    hdel: vi.fn(),
    hgetall: vi.fn(),
    del: vi.fn(),
    set: vi.fn(),
    expire: vi.fn(),
  };
  return {
    mockGetRedis: vi.fn(() => mockRedis as typeof mockRedis | null),
    mockRedis,
  };
});

vi.mock("./redis.js", () => ({ getRedis: mockGetRedis }));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import after mocks
import { WikiStore, wikiKey } from "./wiki.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStore() {
  return new WikiStore();
}

// ─── wikiKey ──────────────────────────────────────────────────────────────────

describe("wikiKey", () => {
  it("produces cca:wiki:<slug> format", () => {
    expect(wikiKey("gonzih/cc-agent")).toBe("cca:wiki:gonzih/cc-agent");
  });
});

// ─── WikiStore — in-memory fallback (Redis = null) ────────────────────────────

describe("WikiStore — in-memory fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedis.mockReturnValue(null);
  });

  it("savePage and getPage round-trips content", async () => {
    const store = makeStore();
    await store.savePage("gonzih/cc-agent", "Architecture", "## Overview\n\nThis is the arch.");
    const result = await store.getPage("gonzih/cc-agent", "Architecture");
    expect(result).toBe("## Overview\n\nThis is the arch.");
  });

  it("getPage returns null for unknown page", async () => {
    const store = makeStore();
    const result = await store.getPage("gonzih/cc-agent", "Missing");
    expect(result).toBeNull();
  });

  it("listPages returns all saved page names", async () => {
    const store = makeStore();
    await store.savePage("gonzih/cc-agent", "Arch", "content a");
    await store.savePage("gonzih/cc-agent", "Gotchas", "content b");
    const pages = await store.listPages("gonzih/cc-agent");
    expect(pages).toContain("Arch");
    expect(pages).toContain("Gotchas");
    expect(pages).toHaveLength(2);
  });

  it("listPages returns empty array when no pages saved", async () => {
    const store = makeStore();
    const pages = await store.listPages("gonzih/empty-repo");
    expect(pages).toEqual([]);
  });

  it("deletePage removes the page and returns true", async () => {
    const store = makeStore();
    await store.savePage("gonzih/cc-agent", "ToDelete", "content");
    const deleted = await store.deletePage("gonzih/cc-agent", "ToDelete");
    expect(deleted).toBe(true);
    expect(await store.getPage("gonzih/cc-agent", "ToDelete")).toBeNull();
  });

  it("deletePage returns false when page does not exist", async () => {
    const store = makeStore();
    const deleted = await store.deletePage("gonzih/cc-agent", "NonExistent");
    expect(deleted).toBe(false);
  });

  it("getAllPages returns WikiPage objects with name, slug, content", async () => {
    const store = makeStore();
    await store.savePage("gonzih/cc-agent", "Overview", "# Overview");
    const pages = await store.getAllPages("gonzih/cc-agent");
    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe("Overview");
    expect(pages[0].slug).toBe("Overview");
    expect(pages[0].content).toBe("# Overview");
  });

  it("getAllPages returns empty array when no pages", async () => {
    const store = makeStore();
    const pages = await store.getAllPages("gonzih/empty-repo");
    expect(pages).toEqual([]);
  });

  it("deleteAll removes all pages for a repo", async () => {
    const store = makeStore();
    await store.savePage("gonzih/cc-agent", "Arch", "content");
    await store.savePage("gonzih/cc-agent", "Gotchas", "content");
    await store.deleteAll("gonzih/cc-agent");
    expect(await store.listPages("gonzih/cc-agent")).toEqual([]);
  });

  it("pages are isolated by repoSlug", async () => {
    const store = makeStore();
    await store.savePage("gonzih/repo-a", "Page", "content a");
    await store.savePage("gonzih/repo-b", "Page", "content b");
    expect(await store.getPage("gonzih/repo-a", "Page")).toBe("content a");
    expect(await store.getPage("gonzih/repo-b", "Page")).toBe("content b");
  });

  it("savePage overwrites existing page content", async () => {
    const store = makeStore();
    await store.savePage("gonzih/cc-agent", "Guide", "v1 content");
    await store.savePage("gonzih/cc-agent", "Guide", "v2 content");
    expect(await store.getPage("gonzih/cc-agent", "Guide")).toBe("v2 content");
  });
});

// ─── WikiStore — Redis path ────────────────────────────────────────────────────

describe("WikiStore — Redis path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedis.mockReturnValue(mockRedis as unknown as ReturnType<typeof mockGetRedis>);
    mockRedis.hset.mockResolvedValue(1);
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.hget.mockResolvedValue(null);
    mockRedis.hkeys.mockResolvedValue([]);
    mockRedis.hdel.mockResolvedValue(0);
    mockRedis.hgetall.mockResolvedValue(null);
    mockRedis.del.mockResolvedValue(1);
  });

  it("savePage calls hset, expire, and set for updated timestamp", async () => {
    const store = makeStore();
    await store.savePage("gonzih/cc-agent", "Architecture", "## content");
    expect(mockRedis.hset).toHaveBeenCalledWith("cca:wiki:gonzih/cc-agent", "Architecture", "## content");
    expect(mockRedis.expire).toHaveBeenCalledWith("cca:wiki:gonzih/cc-agent", expect.any(Number));
    expect(mockRedis.set).toHaveBeenCalledWith(
      "cca:wiki:gonzih/cc-agent:updated",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}/),
      "EX",
      expect.any(Number),
    );
  });

  it("getPage calls hget and returns value", async () => {
    mockRedis.hget.mockResolvedValue("# page content");
    const store = makeStore();
    const result = await store.getPage("gonzih/cc-agent", "Overview");
    expect(mockRedis.hget).toHaveBeenCalledWith("cca:wiki:gonzih/cc-agent", "Overview");
    expect(result).toBe("# page content");
  });

  it("getPage returns null when hget returns null", async () => {
    mockRedis.hget.mockResolvedValue(null);
    const store = makeStore();
    const result = await store.getPage("gonzih/cc-agent", "Missing");
    expect(result).toBeNull();
  });

  it("listPages calls hkeys and returns page names", async () => {
    mockRedis.hkeys.mockResolvedValue(["Arch", "Gotchas"]);
    const store = makeStore();
    const pages = await store.listPages("gonzih/cc-agent");
    expect(mockRedis.hkeys).toHaveBeenCalledWith("cca:wiki:gonzih/cc-agent");
    expect(pages).toEqual(["Arch", "Gotchas"]);
  });

  it("deletePage calls hdel and returns true when deleted > 0", async () => {
    mockRedis.hdel.mockResolvedValue(1);
    const store = makeStore();
    const result = await store.deletePage("gonzih/cc-agent", "ToDelete");
    expect(mockRedis.hdel).toHaveBeenCalledWith("cca:wiki:gonzih/cc-agent", "ToDelete");
    expect(result).toBe(true);
  });

  it("deletePage returns false when hdel returns 0", async () => {
    mockRedis.hdel.mockResolvedValue(0);
    const store = makeStore();
    const result = await store.deletePage("gonzih/cc-agent", "NonExistent");
    expect(result).toBe(false);
  });

  it("getAllPages calls hgetall and maps to WikiPage array", async () => {
    mockRedis.hgetall.mockResolvedValue({ Arch: "# Arch", Gotchas: "- Watch out" });
    const store = makeStore();
    const pages = await store.getAllPages("gonzih/cc-agent");
    expect(mockRedis.hgetall).toHaveBeenCalledWith("cca:wiki:gonzih/cc-agent");
    expect(pages).toHaveLength(2);
    const names = pages.map(p => p.name);
    expect(names).toContain("Arch");
    expect(names).toContain("Gotchas");
  });

  it("getAllPages returns empty array when hgetall returns null", async () => {
    mockRedis.hgetall.mockResolvedValue(null);
    const store = makeStore();
    const pages = await store.getAllPages("gonzih/cc-agent");
    expect(pages).toEqual([]);
  });

  it("deleteAll calls del for both wiki hash and updated key", async () => {
    const store = makeStore();
    await store.deleteAll("gonzih/cc-agent");
    expect(mockRedis.del).toHaveBeenCalledWith("cca:wiki:gonzih/cc-agent");
    expect(mockRedis.del).toHaveBeenCalledWith("cca:wiki:gonzih/cc-agent:updated");
  });
});

// ─── WikiStore — Redis error fallback ─────────────────────────────────────────

describe("WikiStore — Redis error fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedis.mockReturnValue(mockRedis as unknown as ReturnType<typeof mockGetRedis>);
  });

  it("falls back to in-memory when hset throws", async () => {
    mockRedis.hset.mockRejectedValue(new Error("Redis down"));
    mockRedis.hget.mockRejectedValue(new Error("Redis down"));
    const store = makeStore();
    await store.savePage("gonzih/cc-agent", "Fallback", "content");
    // After Redis failure, in-memory has the value
    mockGetRedis.mockReturnValueOnce(null);
    const result = await store.getPage("gonzih/cc-agent", "Fallback");
    expect(result).toBe("content");
  });

  it("falls back to in-memory list when hkeys throws", async () => {
    mockRedis.hset.mockRejectedValue(new Error("Redis down"));
    mockRedis.hkeys.mockRejectedValue(new Error("Redis down"));
    const store = makeStore();
    await store.savePage("gonzih/cc-agent", "Page1", "c1");
    mockGetRedis.mockReturnValue(null);
    const pages = await store.listPages("gonzih/cc-agent");
    expect(pages).toContain("Page1");
  });
});
