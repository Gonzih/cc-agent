import { execFile } from "child_process";
import { promisify } from "util";
import { Redis } from "ioredis";

const execFileAsync = promisify(execFile);

let redisClient: Redis | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryConnect(attempts = 3): Promise<Redis | null> {
  const delays = [500, 1000, 2000];
  for (let i = 0; i < attempts; i++) {
    try {
      const client = new Redis({
        host: "localhost",
        port: 6379,
        lazyConnect: true,
        connectTimeout: 3000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      await client.connect();
      await client.ping();
      return client;
    } catch {
      if (i < attempts - 1) await sleep(delays[i]);
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
    redisClient = client;
    console.error("[cc-agent] Connected to existing Redis at localhost:6379");
    return;
  }

  // Try Docker
  console.error("[cc-agent] Redis not available, trying Docker...");
  const dockerOk = await tryDocker();
  if (dockerOk) {
    client = await tryConnect(3);
    if (client) {
      redisClient = client;
      console.error("[cc-agent] Redis started via Docker (cc-agent-redis container)");
      return;
    }
  }

  // Try redis-server daemon
  console.error("[cc-agent] Docker failed, trying redis-server daemon...");
  const daemonOk = await tryRedisDaemon();
  if (daemonOk) {
    client = await tryConnect(3);
    if (client) {
      redisClient = client;
      console.error("[cc-agent] Redis started via redis-server daemon");
      return;
    }
  }

  console.error(
    "[cc-agent] Redis unavailable — falling back to in-memory storage (jobs will not persist)"
  );
}

export function getRedis(): Redis | null {
  return redisClient;
}
