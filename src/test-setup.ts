/**
 * Vitest global setup — runs before every test file.
 * Ensures tests use Redis DB=1 and never pollute DB=0 (production).
 */

// Must be set before any module import resolves REDIS_DB
process.env.REDIS_DB = "1";

import { vi, afterEach } from "vitest";
import { Redis } from "ioredis";

// Flush test DB after each test so keys from one test don't bleed into the next.
afterEach(async () => {
  try {
    const client = new Redis({
      host: "localhost",
      port: 6379,
      db: 1,
      lazyConnect: true,
      connectTimeout: 500,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    await client.connect();
    await client.flushdb();
    client.disconnect();
  } catch {
    // Redis not running in CI — no-op, tests use in-memory fallback
  }
});
