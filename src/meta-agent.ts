import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { v4 as randomUUID } from "uuid";
import { getRedis } from "./redis.js";
import { logger } from "./logger.js";
import { injectMcpConfig } from "./mcp-inject.js";
import { getMasterToken } from "./tokens.js";
import {
  META_AGENTS_INDEX,
  metaKey,
  metaAgentStatusKey,
  chatOutgoingChannel,
  metaInputKey,
  chatLogKey,
} from "@gonzih/cc-wire";

const META_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const STATUS_REDIS_TTL = 7 * 24 * 60 * 60; // 7 days

export interface MetaAgentInfo {
  namespace: string;
  repoUrl: string;
  cwd: string;
  pid?: number;
  status: "running" | "idle";
  startedAt: string;
  lastMessageAt?: string;
  // Live status fields
  lastActivity?: string;   // ISO timestamp of last tool use or message
  currentTool?: string;    // Tool being called right now, e.g. "Bash", "Read"
  isTyping?: boolean;      // True when Claude is generating output
  lastMessage?: string;    // Last ~80 chars of the most recent assistant message
  turnCount?: number;      // Number of turns/messages exchanged
}

// Per-process live status tracked in memory; synced to Redis periodically.
interface LiveStatus {
  lastActivity?: string;
  currentTool?: string;
  isTyping: boolean;
  lastMessage?: string;
  turnCount: number;
}

const INPUT_POLL_INTERVAL_MS = 3000;
const CHAT_LOG_MAX = 499;

export class MetaAgentManager {
  // Tracks in-flight per-message claude processes (one per namespace at most).
  private activeProcesses = new Map<string, ChildProcess>();
  private liveStatus = new Map<string, LiveStatus>();
  private pollerHandle: ReturnType<typeof setInterval> | null = null;

  /** Start the global background poller that drains per-namespace input queues every 3s. */
  startPoller(): void {
    if (this.pollerHandle) return;
    this.pollerHandle = setInterval(() => {
      this.pollInputQueues().catch(() => {});
    }, INPUT_POLL_INTERVAL_MS);
  }

  /** Stop the background poller (useful in tests or graceful shutdown). */
  stopPoller(): void {
    if (this.pollerHandle) {
      clearInterval(this.pollerHandle);
      this.pollerHandle = null;
    }
  }

  private async pollInputQueues(): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
      const namespaces = await redis.smembers(META_AGENTS_INDEX);
      for (const ns of namespaces) {
        // One message at a time per namespace — skip if already processing.
        if (this.activeProcesses.has(ns)) continue;
        const raw = await redis.rpop(metaInputKey(ns));
        if (!raw) continue;
        let content: string;
        try {
          const parsed = JSON.parse(raw) as { content?: string };
          content = parsed.content ?? raw;
        } catch {
          content = raw;
        }
        // Log the incoming message to the chat log so the UI can render it as a
        // user bubble alongside Claude's assistant responses.
        // Protocol: ChatMessage shape = { id, source, role, content, timestamp, chatId }
        // Source must be one of: 'telegram' | 'ui' | 'claude' | 'cc-tg'
        const coordinatorEntry = JSON.stringify({
          id: randomUUID(),
          source: "cc-tg",
          role: "user",
          content,
          timestamp: new Date().toISOString(),
          chatId: 0,
        });
        // NOTE: cca:chat:log:{ns} is LIFO (newest first via LPUSH) — consumers must reverse for chronological display
        redis.lpush(chatLogKey(ns), coordinatorEntry).catch(() => {});
        redis.ltrim(chatLogKey(ns), 0, CHAT_LOG_MAX).catch(() => {});
        // Protocol: every LPUSH to chat:log must also PUBLISH to chat:outgoing
        redis.publish(chatOutgoingChannel(ns), coordinatorEntry).catch(() => {});
        this.messageMetaAgent(ns, content).catch((err) => {
          logger.warn("meta-agent:poller-message-failed", { namespace: ns, err: String(err) });
        });
      }
    } catch (err) {
      logger.warn("meta-agent:poller-failed", { err: String(err) });
    }
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

  /**
   * Check if a prior Claude session file exists for the given workspace CWD.
   * Claude stores sessions at ~/.claude/projects/<encoded-path>/ where
   * encoded-path is the CWD with '/' replaced by '-'.
   */
  private hasExistingSession(cwd: string): boolean {
    const encodedPath = cwd.replace(/\//g, "-");
    const sessionDir = join(homedir(), ".claude", "projects", encodedPath);
    if (!existsSync(sessionDir)) return false;
    try {
      const files = readdirSync(sessionDir);
      return files.some((f) => f.endsWith(".jsonl"));
    } catch {
      return false;
    }
  }

  /**
   * Ensure the workspace and initial state exist for a namespace.
   * Does NOT spawn a process — agents are stateless between messages.
   */
  async startMetaAgent(namespace: string, repoUrl?: string): Promise<MetaAgentInfo> {
    // If state already exists, return it as-is.
    const existingState = await this.getState(namespace);
    if (existingState) return existingState;

    const cwd = await this.ensureWorkspace(namespace, repoUrl);
    const effectiveRepoUrl = repoUrl ?? `https://github.com/gonzih/${namespace}`;

    const state: MetaAgentInfo = {
      namespace,
      repoUrl: effectiveRepoUrl,
      cwd,
      status: "idle",
      startedAt: new Date().toISOString(),
    };

    await this.saveState(state);

    // Drain stale input queue if any (legacy key, no longer used by tool handler)
    const redis = getRedis();
    if (redis) await redis.del(metaInputKey(namespace)).catch(() => {});

    this.liveStatus.set(namespace, {
      isTyping: false,
      turnCount: 0,
      lastActivity: new Date().toISOString(),
    });

    // Write initial status to Redis immediately so consumers see the agent
    // without waiting for the first message to be delivered.
    await this.writeLiveStatus(namespace);

    logger.info("meta-agent:started", { namespace, cwd });
    return state;
  }

  /**
   * Deliver a message to a meta-agent by spawning `claude -p <message>`.
   * Uses `--continue` if a prior session file exists in the workspace.
   * Stdout is published line-by-line to cca:chat:outgoing:{namespace}.
   */
  async messageMetaAgent(namespace: string, message: string, repoUrl?: string): Promise<void> {
    const redis = getRedis();
    if (!redis) throw new Error("Redis not available");

    // Guard against concurrent calls for the same namespace.
    if (this.activeProcesses.has(namespace)) {
      const existing = this.activeProcesses.get(namespace)!;
      if (!existing.killed) {
        throw new Error(`Meta-agent for namespace '${namespace}' is already processing a message. Wait for it to finish.`);
      }
      // Process exited but wasn't cleaned up — remove stale entry.
      this.activeProcesses.delete(namespace);
    }

    // Ensure workspace and state exist.
    let state = await this.getState(namespace);
    if (!state) {
      state = await this.startMetaAgent(namespace, repoUrl);
    }

    const cwd = state.cwd;
    const sessionExists = this.hasExistingSession(cwd);
    const claudeArgs = sessionExists
      ? ["--continue", "-p", message, "--dangerously-skip-permissions"]
      : ["-p", message, "--dangerously-skip-permissions"];

    // Inject cc-agent MCP so the meta-agent can call spawn_agent etc.
    injectMcpConfig(cwd, namespace);

    // Update lastMessageAt and mark running.
    state.lastMessageAt = new Date().toISOString();
    state.status = "running";
    await this.saveState(state);

    // Update live status.
    let ls = this.liveStatus.get(namespace);
    if (!ls) {
      ls = { isTyping: true, turnCount: 1, lastActivity: new Date().toISOString() };
      this.liveStatus.set(namespace, ls);
    } else {
      ls.lastActivity = new Date().toISOString();
      ls.isTyping = true;
      ls.turnCount += 1;
    }
    this.writeLiveStatus(namespace).catch(() => {});

    // Inject master token so the claude subprocess can authenticate even when
    // this process (MCP instance) has CLAUDE_* env vars stripped by Claude Code.
    const masterToken = await getMasterToken();
    const spawnEnv = { ...process.env };
    if (masterToken && !spawnEnv.CLAUDE_CODE_OAUTH_TOKEN && !spawnEnv.CLAUDE_TOKENS) {
      spawnEnv.CLAUDE_CODE_OAUTH_TOKEN = masterToken;
    }

    const proc = spawn("claude", claudeArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: spawnEnv,
    });

    this.activeProcesses.set(namespace, proc);

    // Update pid in persisted state.
    state.pid = proc.pid;
    await this.saveState(state);

    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => {
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        this.processOutputLine(namespace, line);
        this.publishOutput(namespace, line).catch(() => {});
      }
    });

    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (chunk: string) => {
      logger.warn("meta-agent:stderr", { namespace, chunk: chunk.slice(0, 200) });
    });

    proc.on("close", (code) => {
      logger.info("meta-agent:message-done", { namespace, code });
      this.activeProcesses.delete(namespace);
      const ls = this.liveStatus.get(namespace);
      if (ls) { ls.isTyping = false; ls.currentTool = undefined; }
      this.writeLiveStatus(namespace).catch(() => {});
      this.updateStatus(namespace, "idle").catch(() => {});
    });

    logger.info("meta-agent:message-spawned", { namespace, pid: proc.pid, sessionExists });
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
    const proc = this.activeProcesses.get(namespace);
    if (proc && !proc.killed) {
      proc.kill();
      this.activeProcesses.delete(namespace);
    }

    const ls = this.liveStatus.get(namespace);
    if (ls) { ls.isTyping = false; ls.currentTool = undefined; }
    this.writeLiveStatus(namespace).catch(() => {});

    await this.updateStatus(namespace, "idle");
    logger.info("meta-agent:stopped", { namespace });
  }

  /** Return live status for a namespace, merged into MetaAgentInfo shape. */
  getLiveStatus(namespace: string): Partial<MetaAgentInfo> {
    const ls = this.liveStatus.get(namespace);
    if (!ls) return {};
    return {
      lastActivity: ls.lastActivity,
      currentTool: ls.currentTool,
      isTyping: ls.isTyping,
      lastMessage: ls.lastMessage,
      turnCount: ls.turnCount,
    };
  }

  /**
   * Parse a stdout line from the Claude process to extract live status signals.
   * Claude Code's streaming output uses patterns like:
   *   - Tool use start: lines containing "Tool:" or JSON with type "tool_use"
   *   - Tool use end: lines containing "Tool result" or type "tool_result"
   *   - Text output: regular assistant text lines
   */
  private processOutputLine(namespace: string, line: string): void {
    const ls = this.liveStatus.get(namespace);
    if (!ls) return;

    const now = new Date().toISOString();
    ls.lastActivity = now;

    // Detect tool use from Claude Code's output format.
    // Claude Code prefixes tool calls with "⏺" or structured JSON events.
    // Match patterns like: "⏺ Bash(..." or JSON {"type":"tool_use","name":"Bash"}
    const toolStartPattern = /(?:^⏺\s+(\w+)\(|"type"\s*:\s*"tool_use".*?"name"\s*:\s*"(\w+)")/;
    const toolEndPattern = /(?:^⏺ Tool result|"type"\s*:\s*"tool_result")/;
    const assistantTextPattern = /^(?![\[{⏺])/; // lines not starting with JSON/tool markers

    const toolMatch = line.match(toolStartPattern);
    if (toolMatch) {
      ls.currentTool = toolMatch[1] ?? toolMatch[2] ?? "Unknown";
      ls.isTyping = false;
    } else if (toolEndPattern.test(line)) {
      ls.currentTool = undefined;
      ls.isTyping = true; // Claude is now processing the result and generating
    } else if (assistantTextPattern.test(line) && line.trim().length > 0) {
      // Regular assistant text output — Claude is typing
      ls.isTyping = true;
      ls.currentTool = undefined;
      // Keep last ~80 chars of last non-empty text line
      const trimmed = line.trim();
      ls.lastMessage = trimmed.length > 80 ? trimmed.slice(-80) : trimmed;
    }

    // Write updated status to Redis (fire-and-forget)
    this.writeLiveStatus(namespace).catch(() => {});
  }

  /** Write live status to Redis key cca:meta-agent:status:{namespace} */
  private async writeLiveStatus(namespace: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    const ls = this.liveStatus.get(namespace);
    if (!ls) return;
    try {
      const state = await this.getState(namespace);
      const payload = {
        namespace,
        status: state?.status ?? "idle",
        pid: state?.pid,
        startedAt: state?.startedAt,
        lastActivity: ls.lastActivity,
        currentTool: ls.currentTool,
        isTyping: ls.isTyping,
        lastMessage: ls.lastMessage,
        turnCount: ls.turnCount,
        updatedAt: new Date().toISOString(),
      };
      await redis.set(metaAgentStatusKey(namespace), JSON.stringify(payload), "EX", STATUS_REDIS_TTL);
    } catch (err) {
      logger.warn("meta-agent:write-live-status-failed", { namespace, err: String(err) });
    }
  }

  private async publishOutput(namespace: string, line: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    // Protocol: ChatMessage shape = { id, source, role, content, timestamp, chatId }
    // Source must be one of: 'telegram' | 'ui' | 'claude' | 'cc-tg'
    const message = JSON.stringify({
      id: randomUUID(),
      source: "claude",
      role: "assistant",
      content: line,
      timestamp: new Date().toISOString(),
      chatId: 0,
    });
    try {
      await redis.publish(chatOutgoingChannel(namespace), message);
      // NOTE: cca:chat:log:{ns} is LIFO (newest first via LPUSH) — consumers must reverse for chronological display
      await redis.lpush(chatLogKey(namespace), message);
      await redis.ltrim(chatLogKey(namespace), 0, CHAT_LOG_MAX);
    } catch (err) {
      logger.warn("meta-agent:publish-failed", { namespace, err: String(err) });
    }
  }

  private async saveState(state: MetaAgentInfo): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
      await redis.set(metaKey(state.namespace), JSON.stringify(state), "EX", META_TTL_SECONDS);
      await redis.sadd(META_AGENTS_INDEX, state.namespace);
    } catch (err) {
      logger.error("meta-agent:save-state-failed", { namespace: state.namespace, err: String(err) });
    }
  }

  private async getState(namespace: string): Promise<MetaAgentInfo | null> {
    const redis = getRedis();
    if (!redis) return null;
    try {
      const raw = await redis.get(metaKey(namespace));
      if (!raw) return null;
      const state = JSON.parse(raw) as MetaAgentInfo;
      // Reflect live process state
      const proc = this.activeProcesses.get(namespace);
      if (proc && !proc.killed) {
        state.status = "running";
        state.pid = proc.pid;
      } else if (state.status === "running") {
        // No active process tracked (e.g. after a server restart) — correct stale "running" status.
        state.status = "idle";
        state.pid = undefined;
      }
      // Merge in-memory live status fields
      const ls = this.liveStatus.get(namespace);
      if (ls) {
        state.lastActivity = ls.lastActivity;
        state.currentTool = ls.currentTool;
        state.isTyping = ls.isTyping;
        state.lastMessage = ls.lastMessage;
        state.turnCount = ls.turnCount;
      }
      return state;
    } catch {
      return null;
    }
  }

  private async updateStatus(namespace: string, status: "running" | "idle"): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
      const raw = await redis.get(metaKey(namespace));
      if (!raw) return;
      const state = JSON.parse(raw) as MetaAgentInfo;
      state.status = status;
      if (status === "idle") state.pid = undefined;
      await redis.set(metaKey(namespace), JSON.stringify(state), "EX", META_TTL_SECONDS);
    } catch (err) {
      logger.error("meta-agent:update-status-failed", { namespace, err: String(err) });
    }
  }
}

export const metaAgentManager = new MetaAgentManager();
