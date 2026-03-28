/**
 * One-time backfill: normalize repoUrl owner to lowercase in all Redis job records,
 * and rename any cca:learnings:* keys that have uppercase owners.
 *
 * Run:
 *   npx ts-node --esm scripts/normalize-repo-urls.ts
 *   # or, after build:
 *   node -e "import('./dist/scripts/normalize-repo-urls.js')"
 */

import { Redis } from "ioredis";

function normalizeRepoUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      parts[0] = parts[0].toLowerCase();
      u.pathname = "/" + parts.join("/");
    }
    return u.toString();
  } catch {
    return url.toLowerCase();
  }
}

async function main(): Promise<void> {
  const db = parseInt(process.env.REDIS_DB ?? "0", 10);
  const redis = new Redis({ host: "localhost", port: 6379, db, lazyConnect: true });
  await redis.connect();
  await redis.ping();

  let jobsPatched = 0;
  let learningsRenamed = 0;

  // ── Patch job records ───────────────────────────────────────────────────────
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "cca:job:*", "COUNT", "100");
    cursor = next;
    for (const key of keys) {
      // Only process plain string keys (skip :output, :input, etc. which are lists)
      const keyType = await redis.type(key);
      if (keyType !== "string") continue;

      const raw = await redis.get(key);
      if (!raw) continue;

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }

      const original = record.repoUrl as string | undefined;
      if (!original) continue;

      const normalized = normalizeRepoUrl(original);
      if (normalized === original) continue;

      record.repoUrl = normalized;
      await redis.set(key, JSON.stringify(record), "KEEPTTL");
      jobsPatched++;
      console.log(`  patched job ${key}: ${original} → ${normalized}`);
    }
  } while (cursor !== "0");

  // ── Rename learnings keys ───────────────────────────────────────────────────
  cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "cca:learnings:*", "COUNT", "100");
    cursor = next;
    for (const key of keys) {
      // Key format: cca:learnings:<owner>/<repo>  or  cca:learnings:<namespace>
      const prefix = "cca:learnings:";
      const namespaceRaw = key.slice(prefix.length);
      // Only normalize keys that look like owner/repo
      const slashIdx = namespaceRaw.indexOf("/");
      if (slashIdx === -1) continue;

      const owner = namespaceRaw.slice(0, slashIdx);
      const rest = namespaceRaw.slice(slashIdx);
      const ownerNorm = owner.toLowerCase();
      if (ownerNorm === owner) continue; // already lowercase

      const newKey = prefix + ownerNorm + rest;
      const ttl = await redis.ttl(key);

      // LRANGE all entries, write to new key, delete old
      const entries = await redis.lrange(key, 0, -1);
      if (entries.length > 0) {
        await redis.rpush(newKey, ...entries);
        if (ttl > 0) await redis.expire(newKey, ttl);
      }
      await redis.del(key);
      learningsRenamed++;
      console.log(`  renamed learnings key: ${key} → ${newKey} (${entries.length} entries)`);
    }
  } while (cursor !== "0");

  await redis.quit();
  console.log(`\nSummary: ${jobsPatched} job(s) patched, ${learningsRenamed} learnings key(s) renamed.`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
