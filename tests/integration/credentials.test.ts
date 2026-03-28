/**
 * Credential injection integration tests.
 *
 * Verifies that host credentials (GitHub token, git identity, npm token)
 * are correctly forwarded into Docker containers.
 *
 * Run via: npm run test:integration
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { skipIfNoApiKey } from "./helpers.js";
import { buildDockerCredentialArgs, getDockerEnv } from "../../src/docker.js";
import { runDockerAgent } from "../../src/docker.js";

const execFileAsync = promisify(execFile);

// ─── buildDockerCredentialArgs unit-level tests (no Docker required) ──────────

describe("buildDockerCredentialArgs", () => {
  test("forwards CLAUDE_CODE_OAUTH_TOKEN when set", () => {
    const original = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-oauth-token";
      const { args } = buildDockerCredentialArgs();
      // Find -e CLAUDE_CODE_OAUTH_TOKEN=... pair
      const idx = args.indexOf("-e");
      const envEntries: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-e" && args[i + 1]) envEntries.push(args[i + 1] as string);
      }
      assert.ok(
        envEntries.some((e) => e === "CLAUDE_CODE_OAUTH_TOKEN=test-oauth-token"),
        `CLAUDE_CODE_OAUTH_TOKEN not found in docker args: ${envEntries.join(", ")}`,
      );
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = original;
    }
  });

  test("does not include CLAUDE_CODE_OAUTH_TOKEN when unset", () => {
    const original = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const { args } = buildDockerCredentialArgs();
      const envEntries: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-e" && args[i + 1]) envEntries.push(args[i + 1] as string);
      }
      assert.ok(
        !envEntries.some((e) => e.startsWith("CLAUDE_CODE_OAUTH_TOKEN=")),
        "CLAUDE_CODE_OAUTH_TOKEN should not appear when env var is unset",
      );
    } finally {
      if (original !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = original;
    }
  });

  test("sets git identity fallback env vars when host .gitconfig has no email", () => {
    // buildDockerCredentialArgs reads ~/.gitconfig; if no email, sets fallback vars.
    // We test by checking the return value: hasGitIdentity tells us which path was taken.
    const { args, hasGitIdentity } = buildDockerCredentialArgs();

    if (!hasGitIdentity) {
      // Expect the fallback git identity env vars to be present
      const envEntries: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-e" && args[i + 1]) envEntries.push(args[i + 1] as string);
      }
      assert.ok(
        envEntries.some((e) => e.startsWith("GIT_AUTHOR_EMAIL=")),
        `Expected GIT_AUTHOR_EMAIL fallback in args: ${envEntries.join(", ")}`,
      );
      assert.ok(
        envEntries.some((e) => e.startsWith("GIT_COMMITTER_EMAIL=")),
        `Expected GIT_COMMITTER_EMAIL fallback in args: ${envEntries.join(", ")}`,
      );
    } else {
      // gitconfig with email is mounted — fallback vars should NOT be present
      const envEntries: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-e" && args[i + 1]) envEntries.push(args[i + 1] as string);
      }
      assert.ok(
        !envEntries.some((e) => e.startsWith("GIT_AUTHOR_EMAIL=")),
        "GIT_AUTHOR_EMAIL should not be set when .gitconfig has an email",
      );
    }
  });
});

// ─── Container env injection tests (Docker required) ─────────────────────────

describe("Docker credential injection", () => {
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
    "GITHUB_TOKEN is available inside Docker container",
    { timeout: 60_000 },
    async (t) => {
      if (!dockerAvailable) {
        t.skip("Docker not available");
        return;
      }

      const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "test-gh-token";

      // Run a minimal container that checks whether GITHUB_TOKEN is non-empty.
      // Use /bin/sh test builtin (POSIX) rather than bash [[ ]] for portability.
      const { stdout } = await execFileAsync(
        "docker",
        [
          "run",
          "--rm",
          "-e",
          `GITHUB_TOKEN=${ghToken}`,
          "node:22-slim",
          "/bin/sh",
          "-c",
          "if [ -n \"$GITHUB_TOKEN\" ]; then echo GH_TOKEN_SET=yes; else echo GH_TOKEN_SET=no; fi",
        ],
        { timeout: 60_000, env: getDockerEnv() },
      );

      assert.ok(
        (stdout as string).includes("GH_TOKEN_SET=yes"),
        `Expected GH_TOKEN_SET=yes, got: ${stdout}`,
      );
    },
  );

  test(
    "git global user.email is configured inside Docker container",
    { timeout: 60_000 },
    async (t) => {
      if (!dockerAvailable) {
        t.skip("Docker not available");
        return;
      }

      // runDockerAgent always configures git at system level:
      //   git config --system user.email 'cc-agent@localhost'
      // We replicate that here to verify the pattern works.
      const { stdout } = await execFileAsync(
        "docker",
        [
          "run",
          "--rm",
          "node:22-slim",
          "/bin/sh",
          "-c",
          [
            "apt-get update -qq >/dev/null 2>&1",
            "apt-get install -y -qq git >/dev/null 2>&1",
            "git config --system user.email 'cc-agent@localhost'",
            "git config user.email",
          ].join(" && "),
        ],
        { timeout: 60_000, env: getDockerEnv() },
      );

      const email = (stdout as string).trim();
      assert.ok(
        email.includes("@"),
        `Expected an email address, got: ${email}`,
      );
    },
  );

  test(
    "GITHUB_TOKEN is available inside cc-agent Docker job (smoke test + real Claude)",
    { timeout: 180_000 },
    async (t) => {
      if (!dockerAvailable) {
        t.skip("Docker not available");
        return;
      }
      if (skipIfNoApiKey(t)) return;

      const containerName = `cc-agent-cred-test-${Date.now()}`;
      const token =
        process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
      const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";

      if (!ghToken) {
        t.skip("GH_TOKEN / GITHUB_TOKEN not set");
        return;
      }

      const lines: string[] = [];
      const proc = runDockerAgent({
        containerName,
        repoUrl: "https://github.com/Gonzih/cc-tg",
        task: 'Run `if [ -n "$GITHUB_TOKEN" ]; then echo GH_TOKEN_SET=yes; else echo GH_TOKEN_SET=no; fi` and report the output. Do nothing else.',
        anthropicToken: token,
        githubToken: ghToken,
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
        `Container exited with code ${exitCode}. Output:\n${lines.slice(-20).join("\n")}`,
      );
      assert.ok(
        lines.some((l) => l.includes("GH_TOKEN_SET=yes")),
        `Expected GH_TOKEN_SET=yes in output. Got:\n${lines.slice(-20).join("\n")}`,
      );
    },
  );
});
