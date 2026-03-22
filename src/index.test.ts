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
    cb?: (err: null, result: { stdout: string; stderr: string }) => void
  ) {
    const callback =
      typeof optsOrCb === "function" ? (optsOrCb as Function) : cb!;
    // Return {stdout, stderr} objects so promisify(execFile) resolves correctly
    const args = _args ?? [];
    if (args[0] === "issue" && args[1] === "list") {
      callback(null, { stdout: "[]", stderr: "" });
    } else if (args[0] === "issue" && args[1] === "view") {
      callback(null, { stdout: JSON.stringify({ number: 1, title: "Test issue", body: "body", url: "https://github.com/test/repo/issues/1", comments: [] }), stderr: "" });
    } else if (args[0] === "issue" && args[1] === "create") {
      callback(null, { stdout: JSON.stringify({ number: 99, url: "https://github.com/untrusted-owner/repo/issues/99" }), stderr: "" });
    } else {
      callback(null, { stdout: "", stderr: "" });
    }
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
    expect(names).toContain("get_logs");
    expect(names).toContain("wake_job");
    expect(names).toContain("list_model_ratings");
    expect(names).toContain("list_project_issues");
    expect(names).toContain("work_on_issue");
    expect(names).toContain("comment_on_issue");
    expect(names).toContain("close_issue");
    expect(names).toContain("approve_job");
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

  it("spawn_agent with trusted owner returns job_id and started status", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: {
        name: "spawn_agent",
        arguments: {
          repo_url: "https://github.com/gonzih/repo.git",
          task: "Write tests",
        },
      },
    });
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.job_id).toBe("string");
    expect(data.status).toBe("started");
  });

  it("spawn_agent with untrusted owner returns pending_approval status", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: {
        name: "spawn_agent",
        arguments: {
          repo_url: "https://github.com/untrusted-owner/repo.git",
          task: "Write tests",
        },
      },
    });
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.job_id).toBe("string");
    expect(data.status).toBe("pending_approval");
    expect(data.approval_issue_url).toBeDefined();
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

  it("wake_job with unknown ID returns error status", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: {
        name: "wake_job",
        arguments: { job_id: "nonexistent-id-xyz" },
      },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe("error");
    expect(data.message).toMatch(/not found/i);
  });

  it("list_model_ratings returns array", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: { name: "list_model_ratings", arguments: {} },
    });
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.ratings)).toBe(true);
    expect(typeof data.total).toBe("number");
  });

  it("approve_job with unknown ID returns error status", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: { name: "approve_job", arguments: { job_id: "nonexistent-id-xyz" } },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe("error");
    expect(data.message).toMatch(/not found/i);
  });

  it("unknown tool throws an error", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    await expect(
      handler({ params: { name: "not_a_tool", arguments: {} } })
    ).rejects.toThrow("Unknown tool");
  });

  it("list_project_issues returns issues array", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: { name: "list_project_issues", arguments: { repo: "test/repo" } },
    });
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.issues)).toBe(true);
    expect(typeof data.total).toBe("number");
  });

  it("work_on_issue spawns an agent and returns job_id", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: { name: "work_on_issue", arguments: { repo: "test/repo", issue_number: 1 } },
    });
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.job_id).toBe("string");
    expect(data.issue_number).toBe(1);
  });

  it("comment_on_issue returns ok", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: { name: "comment_on_issue", arguments: { repo: "test/repo", issue_number: 1, body: "hello" } },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
  });

  it("close_issue returns ok", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: { name: "close_issue", arguments: { repo: "test/repo", issue_number: 1 } },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
  });

  it("cost_summary returns total_cost_usd, total_input_tokens, total_output_tokens, by_job", async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema)!;
    const result = await handler({
      params: { name: "cost_summary", arguments: {} },
    });
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.total_cost_usd).toBe("number");
    expect(typeof data.total_input_tokens).toBe("number");
    expect(typeof data.total_output_tokens).toBe("number");
    expect(Array.isArray(data.by_job)).toBe(true);
  });
});
