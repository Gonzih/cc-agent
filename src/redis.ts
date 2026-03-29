import { execFile } from "child_process";
import { promisify } from "util";
import { Redis } from "ioredis";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

let redisClient: Redis | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRedisDb(): number {
  return parseInt(process.env.REDIS_DB ?? "0", 10);
}

async function tryConnect(attempts = 10, delayMs = 500): Promise<Redis | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const client = new Redis({
        host: "localhost",
        port: 6379,
        db: getRedisDb(),
        lazyConnect: true,
        connectTimeout: 3000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      client.on('error', (err: Error) => {
        logger.warn('redis:client-error (non-fatal)', { err: err.message });
      });
      await client.connect();
      await client.ping();
      return client;
    } catch {
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  return null;
}

async function tryDocker(): Promise<boolean> {
  try {
    await execFileAsync("docker", [
      "run", "-d",
      "--name", "cc-agent-redis",
      "-p", "6379:6379",
      "--restart=unless-stopped",
      "redis:alpine",
    ]);
    await sleep(1500);
    return true;
  } catch {
    // Container may already exist — try starting it
    try {
      await execFileAsync("docker", ["start", "cc-agent-redis"]);
      await sleep(1000);
      return true;
    } catch {
      return false;
    }
  }
}

async function tryRedisDaemon(): Promise<boolean> {
  try {
    await execFileAsync("which", ["redis-server"]);
    await execFileAsync("redis-server", [
      "--daemonize", "yes",
      "--port", "6379",
      "--logfile", "/tmp/cc-agent-redis.log",
    ]);
    await sleep(500);
    return true;
  } catch {
    return false;
  }
}

export async function initRedis(): Promise<void> {
  // Try direct connection first (Redis already running)
  let client = await tryConnect(1);
  if (client) {
    logger.info("redis:connected", { host: "localhost", port: 6379, db: getRedisDb() });
    redisClient = client;
    return;
  }

  // Try Docker
  logger.warn("redis:unavailable — trying Docker");
  const dockerOk = await tryDocker();
  if (dockerOk) {
    client = await tryConnect(10, 500);
    if (client) {
      logger.info("redis:connected via Docker (cc-agent-redis container)", { db: getRedisDb() });
      redisClient = client;
      return;
    }
  }

  // Try redis-server daemon
  logger.warn("redis:Docker failed — trying redis-server daemon");
  const daemonOk = await tryRedisDaemon();
  if (daemonOk) {
    client = await tryConnect(10, 500);
    if (client) {
      logger.info("redis:connected via redis-server daemon", { db: getRedisDb() });
      redisClient = client;
      return;
    }
  }

  logger.warn("redis:unavailable — falling back to in-memory storage (jobs will not persist)");
}

export function getRedis(): Redis | null {
  return redisClient;
}
