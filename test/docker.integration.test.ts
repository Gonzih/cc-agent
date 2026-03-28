import { describe, it } from "vitest";
import * as assert from "node:assert/strict";
import { runDockerAgent } from "../src/docker.js";

describe("Docker integration", () => {
  it(
    "container starts and runs successfully (smoke test)",
    { timeout: 120_000 },
    async () => {
      const lines: string[] = [];
      const proc = runDockerAgent({
        containerName: `cc-agent-test-${Date.now()}`,
        repoUrl: "https://github.com/Gonzih/cc-agent",
        task: "echo integration-test-ok",
        anthropicToken: "test-token",
        githubToken: process.env.GH_TOKEN ?? "",
        namespace: "test",
        smokeTest: true,
      });

      proc.on("text", (line: string) => lines.push(line));

      const exitCode = await new Promise<number>((resolve) => {
        proc.on("exit", (code: number) => resolve(code));
        proc.on("error", () => resolve(1));
      });

      assert.strictEqual(
        exitCode,
        0,
        `Container exited with ${exitCode}. Output:\n${lines.join("\n")}`,
      );
      assert.ok(
        lines.some((l) => l.includes("integration-test-ok")),
        `Expected echo output. Got:\n${lines.join("\n")}`,
      );
    },
  );
});
