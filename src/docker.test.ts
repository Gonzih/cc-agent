import { describe, it, expect, vi, beforeEach } from "vitest";

// util.promisify.custom is Symbol.for('nodejs.util.promisify.custom')
const PROMISIFY_CUSTOM = Symbol.for("nodejs.util.promisify.custom");

// Use vi.hoisted to define mocks before hoisting
const mockExecFileFn = vi.hoisted(() => {
  const fn = vi.fn();
  // Add util.promisify.custom so promisify(execFile) resolves with {stdout, stderr}
  const customFn = vi.fn(async (_cmd: string, _args: string[], _opts?: unknown) => {
    return { stdout: "", stderr: "" };
  });
  (fn as any)[Symbol.for("nodejs.util.promisify.custom")] = customFn;
  return fn;
});

const mockSpawnFn = vi.hoisted(() => {
  return vi.fn();
});

vi.mock("child_process", () => ({
  execFile: mockExecFileFn,
  spawn: mockSpawnFn,
}));

import { EventEmitter } from "events";
import { isDockerAvailable, listCcAgentContainers, runDockerAgent } from "./docker.js";

function makeSpawnEmitter() {
  const emitter = new EventEmitter() as any;
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  emitter.kill = vi.fn();
  return emitter;
}

describe("isDockerAvailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when docker info succeeds", async () => {
    (mockExecFileFn as any)[PROMISIFY_CUSTOM].mockResolvedValueOnce({ stdout: "Server: Docker Engine", stderr: "" });
    const result = await isDockerAvailable();
    expect(result).toBe(true);
  });

  it("returns false when docker info fails", async () => {
    (mockExecFileFn as any)[PROMISIFY_CUSTOM].mockRejectedValueOnce(new Error("docker: command not found"));
    const result = await isDockerAvailable();
    expect(result).toBe(false);
  });
});

describe("listCcAgentContainers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no containers are running", async () => {
    (mockExecFileFn as any)[PROMISIFY_CUSTOM].mockResolvedValueOnce({ stdout: "", stderr: "" });
    const result = await listCcAgentContainers();
    expect(result).toEqual([]);
  });

  it("parses container list output", async () => {
    (mockExecFileFn as any)[PROMISIFY_CUSTOM].mockResolvedValueOnce({
      stdout: "abc123\tcc-agent-job1\tUp 2 minutes\t2 minutes ago\n",
      stderr: "",
    });
    const result = await listCcAgentContainers();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("cc-agent-job1");
    expect(result[0].id).toBe("abc123");
    expect(result[0].status).toBe("Up 2 minutes");
  });

  it("returns empty array when docker ps fails", async () => {
    (mockExecFileFn as any)[PROMISIFY_CUSTOM].mockRejectedValueOnce(new Error("docker not available"));
    const result = await listCcAgentContainers();
    expect(result).toEqual([]);
  });
});

describe("runDockerAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default spawn mock
    mockSpawnFn.mockImplementation(() => makeSpawnEmitter());
    // Default execFile promisify custom
    (mockExecFileFn as any)[PROMISIFY_CUSTOM].mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("returns an emitter with kill, pid, stdin properties", () => {
    const proc = runDockerAgent({
      containerName: "cc-agent-test",
      repoUrl: "https://github.com/test/repo",
      task: "do the thing",
    });
    expect(typeof proc.kill).toBe("function");
    expect(proc.pid).toBeUndefined();
    expect(proc.stdin).toBeNull();
  });

  it("emits exit event after container completes successfully", async () => {
    const customPromisify = (mockExecFileFn as any)[PROMISIFY_CUSTOM];
    customPromisify
      .mockResolvedValueOnce({ stdout: "container-id-123\n", stderr: "" }) // docker run -d
      .mockResolvedValueOnce({ stdout: "0\n", stderr: "" })               // docker wait
      .mockResolvedValue({ stdout: "", stderr: "" });                       // docker rm

    const spawnEmitter = makeSpawnEmitter();
    mockSpawnFn.mockReturnValue(spawnEmitter);

    const proc = runDockerAgent({
      containerName: "cc-agent-exittest",
      repoUrl: "https://github.com/test/repo",
      task: "do the thing",
      anthropicToken: "test-token",
    });

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("exit", (code: number) => resolve(code));
    });

    expect(exitCode).toBe(0);
  });

  it("emits exit code 1 on non-zero container exit", async () => {
    const customPromisify = (mockExecFileFn as any)[PROMISIFY_CUSTOM];
    customPromisify
      .mockResolvedValueOnce({ stdout: "cid\n", stderr: "" }) // docker run -d
      .mockResolvedValueOnce({ stdout: "1\n", stderr: "" })  // docker wait
      .mockResolvedValue({ stdout: "", stderr: "" });          // docker rm

    const spawnEmitter = makeSpawnEmitter();
    mockSpawnFn.mockReturnValue(spawnEmitter);

    const proc = runDockerAgent({
      containerName: "cc-agent-failtest",
      repoUrl: "https://github.com/test/repo",
      task: "failing task",
    });

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("exit", (code: number) => resolve(code));
      proc.on("error", () => resolve(99));
    });

    expect(exitCode).toBe(1);
  });

  it("passes environment variables to docker run", async () => {
    const customPromisify = (mockExecFileFn as any)[PROMISIFY_CUSTOM];
    const capturedArgs: string[][] = [];

    customPromisify.mockImplementation(async (_cmd: string, args: string[]) => {
      capturedArgs.push(args);
      if (args[0] === "run") return { stdout: "cid\n", stderr: "" };
      if (args[0] === "wait") return { stdout: "0\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });

    const spawnEmitter = makeSpawnEmitter();
    mockSpawnFn.mockReturnValue(spawnEmitter);

    const proc = runDockerAgent({
      containerName: "cc-agent-envtest",
      repoUrl: "https://github.com/test/repo",
      task: "test",
      anthropicToken: "sk-test",
      githubToken: "ghp-test",
      namespace: "test-ns",
    });

    await new Promise<void>((resolve) => { proc.on("exit", () => resolve()); });

    const runArgs = capturedArgs.find((a) => a[0] === "run");
    expect(runArgs).toBeDefined();
    const argsStr = runArgs!.join(" ");
    expect(argsStr).toContain("ANTHROPIC_AUTH_TOKEN=sk-test");
    expect(argsStr).toContain("GITHUB_TOKEN=ghp-test");
    expect(argsStr).toContain("CC_AGENT_NAMESPACE=test-ns");
    expect(argsStr).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-test");
    expect(argsStr).toContain("--name");
    expect(argsStr).toContain("cc-agent-envtest");
    expect(argsStr).toContain("--label");
    expect(argsStr).toContain("cc-agent");
    expect(argsStr).toContain("node:22-slim");
  });

  it("runs claude as non-root agent user to satisfy --dangerously-skip-permissions", async () => {
    const customPromisify = (mockExecFileFn as any)[PROMISIFY_CUSTOM];
    const capturedArgs: string[][] = [];

    customPromisify.mockImplementation(async (_cmd: string, args: string[]) => {
      capturedArgs.push(args);
      if (args[0] === "run") return { stdout: "cid\n", stderr: "" };
      if (args[0] === "wait") return { stdout: "0\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });

    const spawnEmitter = makeSpawnEmitter();
    mockSpawnFn.mockReturnValue(spawnEmitter);

    const proc = runDockerAgent({
      containerName: "cc-agent-nonroottest",
      repoUrl: "https://github.com/test/repo",
      task: "test",
    });

    await new Promise<void>((resolve) => { proc.on("exit", () => resolve()); });

    const runArgs = capturedArgs.find((a) => a[0] === "run");
    expect(runArgs).toBeDefined();
    const script = runArgs!.join(" ");
    expect(script).toContain("useradd");
    expect(script).toContain("su -p agent /home/agent/run.sh");
    // Claude runs inside run.sh (as agent user), not directly in the root script
    expect(script).toContain("printf");
  });

  it("passes IN_DOCKER=true and DOCKER_CONTAINER=1 to docker run", async () => {
    const customPromisify = (mockExecFileFn as any)[PROMISIFY_CUSTOM];
    const capturedArgs: string[][] = [];

    customPromisify.mockImplementation(async (_cmd: string, args: string[]) => {
      capturedArgs.push(args);
      if (args[0] === "run") return { stdout: "cid\n", stderr: "" };
      if (args[0] === "wait") return { stdout: "0\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });

    const spawnEmitter = makeSpawnEmitter();
    mockSpawnFn.mockReturnValue(spawnEmitter);

    const proc = runDockerAgent({
      containerName: "cc-agent-inDockerTest",
      repoUrl: "https://github.com/test/repo",
      task: "test",
    });

    await new Promise<void>((resolve) => { proc.on("exit", () => resolve()); });

    const runArgs = capturedArgs.find((a) => a[0] === "run");
    expect(runArgs).toBeDefined();
    const argsStr = runArgs!.join(" ");
    expect(argsStr).toContain("IN_DOCKER=true");
    expect(argsStr).toContain("DOCKER_CONTAINER=1");
  });
});
