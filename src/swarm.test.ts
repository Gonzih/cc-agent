import { describe, it, expect } from "vitest";
import { parseDecomposeResponse, buildSynthesisTask, SWARM_MAX_AGENTS_HARD_CAP } from "./swarm.js";

// ─── parseDecomposeResponse ───────────────────────────────────────────────────

describe("parseDecomposeResponse", () => {
  it("parses a clean JSON array", () => {
    const input = `[{"id":"task-1","task":"Implement feature A"},{"id":"task-2","task":"Write tests for B"}]`;
    const result = parseDecomposeResponse(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: "task-1", task: "Implement feature A" });
    expect(result[1]).toEqual({ id: "task-2", task: "Write tests for B" });
  });

  it("extracts JSON array embedded in prose text", () => {
    const input = `Here are the tasks:\n\n[\n  {"id":"task-1","task":"Fix bug in login"},\n  {"id":"task-2","task":"Update docs"}\n]\n\nGood luck!`;
    const result = parseDecomposeResponse(input);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("task-1");
    expect(result[1].task).toBe("Update docs");
  });

  it("extracts JSON array from markdown code fence", () => {
    const input = "Here is the breakdown:\n```json\n[\n  {\"id\":\"task-1\",\"task\":\"Add auth\"},\n  {\"id\":\"task-2\",\"task\":\"Add tests\"}\n]\n```";
    const result = parseDecomposeResponse(input);
    expect(result).toHaveLength(2);
    expect(result[0].task).toBe("Add auth");
  });

  it("throws on completely invalid JSON", () => {
    expect(() => parseDecomposeResponse("not json at all")).toThrow();
  });

  it("filters out tasks with empty task strings", () => {
    const input = `[{"id":"task-1","task":"Valid task"},{"id":"task-2","task":"  "},{"id":"task-3","task":"Another valid"}]`;
    const result = parseDecomposeResponse(input);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.task)).toEqual(["Valid task", "Another valid"]);
  });

  it("auto-generates id from index when id is missing or empty", () => {
    const input = `[{"id":"","task":"Task A"},{"task":"Task B"}]`;
    const result = parseDecomposeResponse(input);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("task-1");
    expect(result[1].id).toBe("task-2");
  });
});

// ─── buildSynthesisTask ───────────────────────────────────────────────────────

describe("buildSynthesisTask", () => {
  const tasks = [
    { id: "task-1", task: "Implement feature A" },
    { id: "task-2", task: "Write tests for B" },
  ];
  const outputs = [
    { taskId: "task-1", task: "Implement feature A", status: "done", lines: ["line1", "line2", "[cc-agent] Done. Exit code: 0"] },
    { taskId: "task-2", task: "Write tests for B", status: "failed", lines: ["error: something went wrong"] },
  ];

  it("includes the original goal in the output", () => {
    const result = buildSynthesisTask("Build a full-stack app", tasks, outputs, "swarm-synthesis.md");
    expect(result).toContain("Build a full-stack app");
  });

  it("includes sub-task descriptions and statuses", () => {
    const result = buildSynthesisTask("Build a full-stack app", tasks, outputs, "swarm-synthesis.md");
    expect(result).toContain("Implement feature A");
    expect(result).toContain("Write tests for B");
    expect(result).toContain("Status: done");
    expect(result).toContain("Status: failed");
  });

  it("includes the synthesis output path", () => {
    const result = buildSynthesisTask("Do something", tasks, outputs, "reports/final.md");
    expect(result).toContain("reports/final.md");
  });

  it("uses custom synthesis prompt when provided", () => {
    const customPrompt = "Focus only on security issues found.";
    const result = buildSynthesisTask("Audit codebase", tasks, outputs, "report.md", customPrompt);
    expect(result).toContain(customPrompt);
  });

  it("uses default synthesis instruction when no custom prompt", () => {
    const result = buildSynthesisTask("Do a thing", tasks, outputs, "out.md");
    expect(result).toContain("synthesize");
    expect(result).toContain("out.md");
  });

  it("includes actual output lines in the task text", () => {
    const result = buildSynthesisTask("Do a thing", tasks, outputs, "out.md");
    expect(result).toContain("line1");
    expect(result).toContain("[cc-agent] Done. Exit code: 0");
    expect(result).toContain("error: something went wrong");
  });
});

// ─── SWARM_MAX_AGENTS_HARD_CAP ────────────────────────────────────────────────

describe("SWARM_MAX_AGENTS_HARD_CAP", () => {
  it("is 50", () => {
    expect(SWARM_MAX_AGENTS_HARD_CAP).toBe(50);
  });
});

// ─── buildSynthesisTask — output truncation ───────────────────────────────────

describe("buildSynthesisTask — output truncation", () => {
  const tasks = [{ id: "task-1", task: "Do the thing" }];

  it("does not truncate outputs within 500 lines / 20 000 chars", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const outputs = [{ taskId: "task-1", task: "Do the thing", status: "done", lines }];
    const result = buildSynthesisTask("goal", tasks, outputs, "out.md");
    for (const line of lines) {
      expect(result).toContain(line);
    }
  });

  it("truncates to last 500 lines when output exceeds 500 lines", () => {
    // 600 lines total — only last 500 should appear
    const lines = Array.from({ length: 600 }, (_, i) => `line-${i}`);
    const outputs = [{ taskId: "task-1", task: "Do the thing", status: "done", lines }];
    const result = buildSynthesisTask("goal", tasks, outputs, "out.md");
    // last 500 lines end at index 599; first 100 lines (0..99) should not appear
    expect(result).toContain("line-599"); // always included (last)
    expect(result).toContain("line-100"); // first of the kept 500
    expect(result).not.toContain("\nline-99\n"); // trimmed off
    // The task string should report total line count
    expect(result).toContain("600 total lines");
    expect(result).toContain("showing last 500");
  });

  it("truncates by char limit when output exceeds 20 000 chars even under 500 lines", () => {
    // Each line is ~300 chars; 100 lines = 30 000 chars > 20 000 limit
    const lines = Array.from({ length: 100 }, (_, i) =>
      `line-${i}-${"x".repeat(290)}`
    );
    const outputs = [{ taskId: "task-1", task: "Do the thing", status: "done", lines }];
    const result = buildSynthesisTask("goal", tasks, outputs, "out.md");
    // The synthesized task must be shorter than it would be without truncation
    // At 300 chars/line × 100 lines = 30 000 chars — truncation must have fired
    const codeBlockContent = result.match(/```\n([\s\S]*?)\n```/)?.[1] ?? "";
    expect(codeBlockContent.length).toBeLessThan(25_000);
    // First line (index 0) should be cut off; last line (index 99) should survive
    expect(result).toContain("line-99");
    expect(result).not.toContain("line-0-"); // too early — truncated away
  });

  it("handles empty output lines gracefully", () => {
    const outputs = [{ taskId: "task-1", task: "Do the thing", status: "done", lines: [] }];
    const result = buildSynthesisTask("goal", tasks, outputs, "out.md");
    expect(result).toContain("Do the thing");
    expect(result).toContain("Status: done");
  });

  it("handles multiple sub-tasks in outputs", () => {
    const multiTasks = [
      { id: "t1", task: "Task One" },
      { id: "t2", task: "Task Two" },
    ];
    const outputs = [
      { taskId: "t1", task: "Task One", status: "done", lines: ["output-one"] },
      { taskId: "t2", task: "Task Two", status: "failed", lines: ["error-two"] },
    ];
    const result = buildSynthesisTask("my goal", multiTasks, outputs, "result.md");
    expect(result).toContain("output-one");
    expect(result).toContain("error-two");
    expect(result).toContain("Task One");
    expect(result).toContain("Task Two");
    expect(result).toContain("2 sub-tasks");
  });
});

// ─── parseDecomposeResponse — additional edge cases ──────────────────────────

describe("parseDecomposeResponse — additional edge cases", () => {
  it("filters out non-object array items (null, number, string)", () => {
    const input = JSON.stringify([null, 42, "string", { id: "t1", task: "Real task" }]);
    const result = parseDecomposeResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].task).toBe("Real task");
  });

  it("filters out objects missing the task field — returns empty array", () => {
    // validateTasks filters items without "task" key; parseDecomposeResponse returns []
    const input = JSON.stringify([{ id: "t1", description: "No task field here" }]);
    const result = parseDecomposeResponse(input);
    expect(result).toHaveLength(0);
  });

  it("handles an array of tasks with only whitespace task strings — returns empty array", () => {
    const input = JSON.stringify([
      { id: "t1", task: "   " },
      { id: "t2", task: "\t\n" },
    ]);
    // All tasks are blank strings — filtered by trim().length > 0 check in validateTasks
    const result = parseDecomposeResponse(input);
    expect(result).toHaveLength(0);
  });

  it("extracts array from JSON fence without language specifier", () => {
    const input = "```\n[{\"id\":\"t1\",\"task\":\"Plain fence task\"}]\n```";
    const result = parseDecomposeResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].task).toBe("Plain fence task");
  });

  it("throws when JSON is valid but not an array (object at top level)", () => {
    const input = JSON.stringify({ id: "t1", task: "not wrapped in array" });
    // Top-level object, no [...] match either
    expect(() => parseDecomposeResponse(input)).toThrow();
  });
});
