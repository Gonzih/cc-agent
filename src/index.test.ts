import { describe, it, expect, vi } from "vitest";

// Capture registered handlers via hoisted state
const capturedHandlers = vi.hoisted(() => new Map<unknown, Function>());

vi.mock("./state.js", () => ({
  ensureStateDirs: vi.fn(),
  loadPersistedJobs: vi.fn(() => []),
  savePersistedJobs: vi.fn(),
  appendLog: vi.fn(),
  readLogSync: vi.fn(() => []),
  isPidAlive: vi.fn(() => false),
}));

vi.mock("./claude.js", async () => {
  const { EventEmitter } = await import("events");
  return {
    runClaude: vi.fn(function () {
      const emitter = new EventEmitter() as any;
      emitter.kill = vi.fn();
      emitter.pid = 12345;
      emitter.stdin = null;
      setTimeout(() => emitter.emit("exit", 0), 50);
      return emitter;
    }),
  };
});

vi.mock("child_process", async () => ({
  execFile: vi.fn(function (
    _cmd: string,
    _args: string[],
    optsOrCb: unknown,
    cb?: (err: null, stdout: string, stderr: string) => void
  ) {
    const callback =
      typeof optsOrCb === "function" ? (optsOrCb as Function) : cb!;
    callback(null, "", "");
  }),
}));

vi.mock("fs/promises", async () => ({
  mkdtemp: vi.fn(() => Promise.resolve("/tmp/test-workdir")),
  rm: vi.fn(() => Promise.resolve()),
}));

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class MockServer {
    setRequestHandler(schema: unknown, handler: Function) {
      capturedHandlers.set(schema, handler);
    }
    connect() {
      return Promise.resolve();
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class MockTransport {},
}));

// Trigger module-level side effects (handler registration)
await import("./index.js");

import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

describe("MCP server handlers", () => {
  it("registers list_tools and call_tool handlers", () => {
    expect(capturedHandlers.has(ListToolsRequestSchema)).toBe(true);
    expect(capturedHandlers.has(CallToolRequestSchema)).toBe(true);
  });

  it("list_tools returns all expected tool names", async () => {
    const handler = capturedHandlers.get(ListToolsRequestSchema)!;
    const result = await handler({});
    const names = result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("spawn_agent");
    expect(names).toContain("get_job_status");
    expect(names).toContain("get_job_output");
    expect(names).toContain("list_jobs");
    expect(names).toContain("cancel_job");
    expect(names).toContain("send_message");
    expect(names).toContain("get_version");
  });

  it("get_version returns a version string", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: { name: "get_version", arguments: {} },
    });
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.version).toBe("string");
    expect(data.version.length).toBeGreaterThan(0);
  });

  it("spawn_agent with valid input returns job_id", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: {
        name: "spawn_agent",
        arguments: {
          repo_url: "https://github.com/test/repo.git",
          task: "Write tests",
        },
      },
    });
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.job_id).toBe("string");
    expect(data.status).toBe("started");
  });

  it("list_jobs returns array", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: { name: "list_jobs", arguments: {} },
    });
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.jobs)).toBe(true);
    expect(typeof data.total).toBe("number");
  });

  it("get_job_output with unknown ID returns empty lines and done=true", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: {
        name: "get_job_output",
        arguments: { job_id: "nonexistent-id-xyz", offset: 0 },
      },
    });
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.lines)).toBe(true);
    expect(data.done).toBe(true);
  });

  it("cancel_job with unknown ID returns cancelled: false", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: {
        name: "cancel_job",
        arguments: { job_id: "nonexistent-id-xyz" },
      },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.cancelled).toBe(false);
  });

  it("get_job_status with unknown ID returns error", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: {
        name: "get_job_status",
        arguments: { job_id: "nonexistent-id-xyz" },
      },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBeDefined();
  });

  it("unknown tool throws an error", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    await expect(
      handler({ params: { name: "not_a_tool", arguments: {} } })
    ).rejects.toThrow("Unknown tool");
  });
});
