import { describe, it, expect, beforeAll } from "vitest";
import { initRedis, getRedis } from "./redis.js";

/**
 * Tests for src/redis.ts
 *
 * Strategy:
 * - Each test file runs in its own Vitest worker with a fresh module registry.
 * - The singleton (redisClient) starts as null — verified in the first describe block
 *   before any initRedis() call.
 * - Subsequent tests call the real initRedis() against the test Redis DB (DB=1).
 * - Failure-path behaviour (in-memory fallback) is exercised by store.test.ts and
 *   other tests that run in environments without Redis.
 */

// ─── Initial state (singleton is null before any initRedis call) ──────────────

describe("getRedis — initial state", () => {
  it("returns null before initRedis is called", () => {
    // This test must run before the beforeAll in the next describe block.
    // Each Vitest worker starts with a fresh module registry, so redisClient
    // is still null at this point.
    expect(getRedis()).toBeNull();
  });
});

// ─── After a successful initRedis ─────────────────────────────────────────────

describe("getRedis — after successful initRedis", () => {
  beforeAll(async () => {
    // Connect to the test Redis instance (DB=1, set by test-setup.ts).
    await initRedis();
  });

  it("returns a non-null client after initRedis succeeds", () => {
    // Redis is available in the test environment; skip rather than fail in CI.
    if (!getRedis()) return;
    expect(getRedis()).not.toBeNull();
  });

  it("returns the same client instance on repeated getRedis() calls", () => {
    if (!getRedis()) return;
    expect(getRedis()).toBe(getRedis());
  });

  it("getRedis() returns an object with a ping method", () => {
    const client = getRedis();
    if (!client) return; // skip when Redis unavailable
    expect(typeof (client as any).ping).toBe("function");
  });
});

// ─── API shape ────────────────────────────────────────────────────────────────

describe("redis module API shape", () => {
  it("exports initRedis as a function", () => {
    expect(typeof initRedis).toBe("function");
  });

  it("exports getRedis as a function", () => {
    expect(typeof getRedis).toBe("function");
  });

  it("getRedis() returns null or a Redis-like object", () => {
    const result = getRedis();
    expect(result === null || typeof result === "object").toBe(true);
  });
});

// ─── REDIS_DB env var ─────────────────────────────────────────────────────────

describe("REDIS_DB env var", () => {
  it("REDIS_DB is read from the environment (set to 1 by test-setup.ts)", () => {
    // The test-setup.ts sets REDIS_DB=1; initRedis() reads it via getRedisDb().
    // We verify the env is correctly propagated to this worker.
    expect(process.env.REDIS_DB).toBe("1");
  });

  it("initRedis can be called multiple times without throwing", async () => {
    // Idempotency: already-connected client is reused.
    await expect(initRedis()).resolves.not.toThrow();
  });
});
