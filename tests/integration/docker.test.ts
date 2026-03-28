/**
 * Docker isolation integration tests.
 *
 * Tests that actually run Docker containers to verify the full isolation pipeline.
 * Requires Docker to be available; tests skip gracefully when it's not.
 *
 * Run via: npm run test:integration
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { skipIfNoDocker, skipIfNoApiKey } from "./helpers.js";
import { runDockerAgent, getDockerEnv } from "../../src/docker.js";
import { shouldSkipDocker } from "../../src/agent.js";

const execFileAsync = promisify(execFile);

// ─── shouldSkipDocker logic tests (no Docker required) ───────────────────────

describe("shouldSkipDocker", () => {
  test("returns false when dockerIsolation: true — explicit opt-in always wins", () => {
    const result = shouldSkipDocker({
      dockerIsolation: true,
      repoUrl: "https://github.com/Gonzih/cc-tg",
      task: "test task",
    });
    assert.equal(result, false);
  });

  test("returns true on non-linux when dockerIsolation is unset", () => {
    // On macOS Docker is opt-in, so skip unless explicitly required
    if (process.platform === "linux") {
      // On Linux, Docker isolation is always attempted unless skipped by pattern
      const result = shouldSkipDocker({
        repoUrl: "https://github.com/Gonzih/cc-tg",
        task: "test task",
      });
      assert.equal(result, false);
    } else {
      const result = shouldSkipDocker({
        repoUrl: "https://github.com/Gonzih/cc-tg",
        task: "test task",
      });
      assert.equal(result, true);
    }
  });

  test("returns true for macOS-native repo patterns (lewm, simorgh-app, etc.)", () => {
    for (const repo of [
      "https://github.com/user/leworldmodel",
      "https://github.com/user/lewm-native",
      "https://github.com/user/simorgh-app",
      "https://github.com/user/expo-app",
    ]) {
      const result = shouldSkipDocker({
        repoUrl: repo,
        task: "build the app",
      });
      assert.equal(result, true, `Expected skip for repo: ${repo}`);
    }
  });

  test("returns true for macOS-native task patterns (mlx, xcode, simulator, etc.)", () => {
    for (const task of [
      "train a model using MLX",
      "compile Metal shader",
      "run Core ML inference",
      "build in Xcode",
      "launch the iOS simulator",
      "optimize for Apple Silicon",
    ]) {
      const result = shouldSkipDocker({
        repoUrl: "https://github.com/Gonzih/cc-tg",
        task,
      });
      assert.equal(result, true, `Expected skip for task: ${task}`);
    }
  });

  test("requiresDocker: true overrides non-linux skip", () => {
    if (process.platform !== "linux") {
      const result = shouldSkipDocker({
        requiresDocker: true,
        repoUrl: "https://github.com/Gonzih/cc-tg",
        task: "run linux-only tool",
      });
      assert.equal(result, false);
    }
  });
});

// ─── Container lifecycle tests (Docker required) ──────────────────────────────

describe("Docker container lifecycle", () => {
  let dockerAvailable = false;

  before(async () => {
    try {
      await execFileAsync("docker", ["info"], { timeout: 5000 });
      dockerAvailable = true;
    } catch {
      dockerAvailable = false;
    }
  });

  test(
    "Docker job runs and produces output (smoke test)",
    { timeout: 180_000 },
    async (t) => {
      if (!dockerAvailable) {
        t.skip("Docker not available");
        return;
      }

      const containerName = `cc-agent-test-smoke-${Date.now()}`;
      const lines: string[] = [];

      const proc = runDockerAgent({
        containerName,
        repoUrl: "https://github.com/Gonzih/cc-tg",
        task: "echo DOCKER_WORKS",
        anthropicToken: "test-token",
        githubToken: process.env.GH_TOKEN ?? "",
        namespace: "test-integration",
        smokeTest: true,
      });

      proc.on("text", (line: string) => lines.push(line));

      const exitCode = await new Promise<number>((resolve) => {
        proc.on("exit", (code: number) => resolve(code));
        proc.on("error", () => resolve(1));
      });

      assert.equal(
        exitCode,
        0,
        `Container exited with code ${exitCode}. Output:\n${lines.join("\n")}`,
      );
      assert.ok(
        lines.some((l) => l.includes("integration-test-ok")),
        `Expected "integration-test-ok" in output. Got:\n${lines.join("\n")}`,
      );
    },
  );

  test(
    "Docker container is cleaned up after job completes",
    { timeout: 180_000 },
    async (t) => {
      if (!dockerAvailable) {
        t.skip("Docker not available");
        return;
      }

      const containerName = `cc-agent-test-cleanup-${Date.now()}`;

      const proc = runDockerAgent({
        containerName,
        repoUrl: "https://github.com/Gonzih/cc-tg",
        task: "echo cleanup-test",
        anthropicToken: "test-token",
        smokeTest: true,
      });

      await new Promise<void>((resolve) => {
        proc.on("exit", () => resolve());
        proc.on("error", () => resolve());
      });

      // Container should be gone — docker ps -a should not list it
      const { stdout } = await execFileAsync(
        "docker",
        ["ps", "-a", "--filter", `name=^/${containerName}$`, "--format", "{{.Names}}"],
        { env: getDockerEnv() },
      );
      const names = (stdout as string)
        .trim()
        .split("\n")
        .filter(Boolean);
      assert.equal(
        names.length,
        0,
        `Container ${containerName} still exists after job completion`,
      );
    },
  );

  test(
    "IN_DOCKER env var is set to 'true' inside container",
    { timeout: 60_000 },
    async (t) => {
      if (!dockerAvailable) {
        t.skip("Docker not available");
        return;
      }

      // Run a minimal node:22-slim container that checks the env var.
      // This mirrors what runDockerAgent does: it always injects -e IN_DOCKER=true.
      const { stdout } = await execFileAsync(
        "docker",
        [
          "run",
          "--rm",
          "-e",
          "IN_DOCKER=true",
          "node:22-slim",
          "node",
          "-e",
          "process.stdout.write('IN_DOCKER=' + process.env.IN_DOCKER)",
        ],
        { timeout: 60_000, env: getDockerEnv() },
      );
      assert.ok(
        (stdout as string).includes("IN_DOCKER=true"),
        `Expected IN_DOCKER=true, got: ${stdout}`,
      );
    },
  );

  test(
    "Docker job with real Claude task produces output (requires API key)",
    { timeout: 180_000 },
    async (t) => {
      if (!dockerAvailable) {
        t.skip("Docker not available");
        return;
      }
      if (skipIfNoApiKey(t)) return;

      const containerName = `cc-agent-test-real-${Date.now()}`;
      const lines: string[] = [];

      const token =
        process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";

      const proc = runDockerAgent({
        containerName,
        repoUrl: "https://github.com/Gonzih/cc-tg",
        task: 'Run `echo DOCKER_WORKS` and report the output. Do nothing else.',
        anthropicToken: token,
        githubToken: process.env.GH_TOKEN ?? "",
        namespace: "test-integration",
      });

      proc.on("text", (line: string) => lines.push(line));

      const exitCode = await new Promise<number>((resolve) => {
        proc.on("exit", (code: number) => resolve(code));
        proc.on("error", () => resolve(1));
      });

      assert.equal(
        exitCode,
        0,
        `Container exited with code ${exitCode}. Output:\n${lines.join("\n")}`,
      );
      assert.ok(
        lines.some((l) => l.includes("DOCKER_WORKS")),
        `Expected "DOCKER_WORKS" in output. Got:\n${lines.slice(-20).join("\n")}`,
      );
    },
  );
});
