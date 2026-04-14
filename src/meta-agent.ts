import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { v4 as randomUUID } from "uuid";
import { getRedis } from "./redis.js";
import { logger } from "./logger.js";

const META_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const META_AGENTS_INDEX = "cca:meta:agents:index";
const INPUT_POLL_INTERVAL_MS = 3000;

export interface MetaAgentInfo {
  namespace: string;
  repoUrl: string;
  cwd: string;
  pid?: number;
  status: "running" | "stopped";
  startedAt: string;
  lastMessageAt?: string;
}

export class MetaAgentManager {
  private processes = new Map<string, ChildProcess>();
  private pollers = new Map<string, ReturnType<typeof setInterval>>();

  private metaKey(namespace: string): string {
    return `cca:meta:${namespace}`;
  }

  private inputKey(namespace: string): string {
    return `cca:meta:${namespace}:input`;
  }

  private outChannel(namespace: string): string {
    return `cca:chat:outgoing:${namespace}`;
  }

  async ensureWorkspace(namespace: string, repoUrl?: string): Promise<string> {
    const cwd = join(homedir(), "cc-agent-workspace", namespace);
    if (!existsSync(cwd)) {
      mkdirSync(join(homedir(), "cc-agent-workspace"), { recursive: true });
      const url = repoUrl ?? `https://github.com/gonzih/${namespace}`;
      logger.info("meta-agent:clone", { namespace, url, cwd });
      execSync(`git clone --depth 1 ${url} ${cwd}`, { stdio: "pipe" });
    }
    return cwd;
  }

  async startMetaAgent(namespace: string, repoUrl?: string): Promise<MetaAgentInfo> {
    // If already running, return current state
    const existing = this.processes.get(namespace);
    if (existing && !existing.killed) {
      const state = await this.getState(namespace);
      if (state) return state;
    }

    const cwd = await this.ensureWorkspace(namespace, repoUrl);
    const effectiveRepoUrl = repoUrl ?? `https://github.com/gonzih/${namespace}`;

    const startedAt = new Date().toISOString();

    // Only pass --continue if a prior session exists for this namespace.
    // On first start, getState returns null → spawn fresh to avoid the
    // "No deferred tool marker found" crash.
    const priorState = await this.getState(namespace);
    const claudeArgs = priorState ? ["--continue"] : [];

    const proc = spawn("claude", claudeArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
      env: process.env,
    });

    // Give the fresh session an initial system message so Claude waits for input.
    if (!priorState) {
      proc.stdin?.write(
        `You are a persistent meta-agent for the ${namespace} repository. Wait for incoming messages and act on them.\n`
      );
    }

    this.processes.set(namespace, proc);

    const state: MetaAgentInfo = {
      namespace,
      repoUrl: effectiveRepoUrl,
      cwd,
      pid: proc.pid,
      status: "running",
      startedAt,
    };

    await this.saveState(state);

    // Publish stdout lines to cca:chat:outgoing:{namespace}
    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => {
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        this.publishOutput(namespace, line).catch(() => {});
      }
    });

    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (chunk: string) => {
      logger.warn("meta-agent:stderr", { namespace, chunk: chunk.slice(0, 200) });
    });

    // Start input poller
    const redis = getRedis();
    if (redis) {
      const poller = setInterval(async () => {
        try {
          if (!proc.stdin || proc.stdin.destroyed) return;
          const raw = await redis.rpop(this.inputKey(namespace));
          if (raw) {
            let content: string;
            try {
              const parsed = JSON.parse(raw) as { id?: string; content?: string; timestamp?: string };
              content = parsed.content ?? raw;
            } catch {
              content = raw;
            }
            proc.stdin.write(`\n<Human>\n${content}\n`);
            logger.info("meta-agent:input-delivered", { namespace });
          }
        } catch {
          // ignore polling errors
        }
      }, INPUT_POLL_INTERVAL_MS);
      (poller as NodeJS.Timeout).unref();
      this.pollers.set(namespace, poller);
    }

    proc.on("close", (code) => {
      logger.info("meta-agent:closed", { namespace, code });
      const poller = this.pollers.get(namespace);
      if (poller) {
        clearInterval(poller);
        this.pollers.delete(namespace);
      }
      this.processes.delete(namespace);
      this.updateStatus(namespace, "stopped").catch(() => {});
    });

    logger.info("meta-agent:started", { namespace, pid: proc.pid, cwd });
    return state;
  }

  async messageMetaAgent(namespace: string, message: string): Promise<void> {
    const redis = getRedis();
    if (!redis) throw new Error("Redis not available");
    const entry = JSON.stringify({
      id: randomUUID(),
      content: message,
      timestamp: new Date().toISOString(),
    });
    await redis.lpush(this.inputKey(namespace), entry);
    await redis.hset(this.metaKey(namespace), "lastMessageAt", new Date().toISOString());
    logger.info("meta-agent:message-queued", { namespace, length: message.length });
  }

  async listMetaAgents(): Promise<MetaAgentInfo[]> {
    const redis = getRedis();
    if (!redis) return [];
    try {
      const namespaces = await redis.smembers(META_AGENTS_INDEX);
      const results: MetaAgentInfo[] = [];
      for (const ns of namespaces) {
        const state = await this.getState(ns);
        if (state) results.push(state);
      }
      return results;
    } catch (err) {
      logger.error("meta-agent:list-failed", { err: String(err) });
      return [];
    }
  }

  async stopMetaAgent(namespace: string): Promise<void> {
    const poller = this.pollers.get(namespace);
    if (poller) {
      clearInterval(poller);
      this.pollers.delete(namespace);
    }

    const proc = this.processes.get(namespace);
    if (proc && !proc.killed) {
      proc.kill();
      this.processes.delete(namespace);
    }

    await this.updateStatus(namespace, "stopped");
    logger.info("meta-agent:stopped", { namespace });
  }

  private async publishOutput(namespace: string, line: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    const message = JSON.stringify({
      id: randomUUID(),
      source: "claude",
      role: "assistant",
      namespace,
      content: line,
      timestamp: new Date().toISOString(),
    });
    try {
      await redis.publish(this.outChannel(namespace), message);
    } catch (err) {
      logger.warn("meta-agent:publish-failed", { namespace, err: String(err) });
    }
  }

  private async saveState(state: MetaAgentInfo): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
      await redis.set(this.metaKey(state.namespace), JSON.stringify(state), "EX", META_TTL_SECONDS);
      await redis.sadd(META_AGENTS_INDEX, state.namespace);
    } catch (err) {
      logger.error("meta-agent:save-state-failed", { namespace: state.namespace, err: String(err) });
    }
  }

  private async getState(namespace: string): Promise<MetaAgentInfo | null> {
    const redis = getRedis();
    if (!redis) return null;
    try {
      const raw = await redis.get(this.metaKey(namespace));
      if (!raw) return null;
      const state = JSON.parse(raw) as MetaAgentInfo;
      // Reflect live process state
      const proc = this.processes.get(namespace);
      if (proc && !proc.killed) {
        state.status = "running";
        state.pid = proc.pid;
      }
      return state;
    } catch {
      return null;
    }
  }

  private async updateStatus(namespace: string, status: "running" | "stopped"): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
      const raw = await redis.get(this.metaKey(namespace));
      if (!raw) return;
      const state = JSON.parse(raw) as MetaAgentInfo;
      state.status = status;
      if (status === "stopped") state.pid = undefined;
      await redis.set(this.metaKey(namespace), JSON.stringify(state), "EX", META_TTL_SECONDS);
    } catch (err) {
      logger.error("meta-agent:update-status-failed", { namespace, err: String(err) });
    }
  }
}

export const metaAgentManager = new MetaAgentManager();
