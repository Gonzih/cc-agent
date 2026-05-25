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

// ─── parseDecomposeResponse — error paths and boundary conditions ─────────────

describe("parseDecomposeResponse - error paths", () => {
  it("returns empty array when all tasks contain only whitespace", () => {
    const result = parseDecomposeResponse(
      '[{"id":"t1","task":"   "},{"id":"t2","task":"\\t\\n"}]'
    );
    expect(result).toHaveLength(0);
  });

  it("returns empty array when no items have a 'task' field", () => {
    const result = parseDecomposeResponse(
      '[{"id":"t1","description":"wrong field"},{"id":"t2","work":"also wrong"}]'
    );
    expect(result).toHaveLength(0);
  });

  it("returns empty array for an empty JSON array", () => {
    const result = parseDecomposeResponse("[]");
    expect(result).toHaveLength(0);
  });

  it("throws on empty string input", () => {
    expect(() => parseDecomposeResponse("")).toThrow();
  });

  it("throws when input is a JSON object, not an array", () => {
    expect(() => parseDecomposeResponse('{"task":"something"}')).toThrow(
      /Cannot extract JSON array/
    );
  });

  it("throws when input is a bare number", () => {
    expect(() => parseDecomposeResponse("42")).toThrow(/Cannot extract JSON array/);
  });

  it("throws when JSON code fence is unclosed and no other valid JSON found", () => {
    expect(() => parseDecomposeResponse("```json\n[{broken")).toThrow();
  });

  it("filters null and primitive items, keeps only valid objects with task", () => {
    const result = parseDecomposeResponse(
      '[null, 42, "str", true, {"id":"t1","task":"Valid"}, {"id":"t2","task":"Also valid"}]'
    );
    expect(result).toHaveLength(2);
    expect(result[0].task).toBe("Valid");
    expect(result[1].task).toBe("Also valid");
  });

  it("coerces numeric task field to string", () => {
    const result = parseDecomposeResponse('[{"id":"t1","task":123}]');
    expect(result).toHaveLength(1);
    expect(result[0].task).toBe("123");
  });

  it("coerces boolean task field to string", () => {
    const result = parseDecomposeResponse('[{"id":"t1","task":true}]');
    expect(result).toHaveLength(1);
    expect(result[0].task).toBe("true");
  });

  it("filters items missing 'task' key while keeping those with task", () => {
    const result = parseDecomposeResponse(
      '[{"id":"t1"},{"id":"t2","task":"Valid task"}]'
    );
    expect(result).toHaveLength(1);
    expect(result[0].task).toBe("Valid task");
  });

  it("extracts array from text even when leading prose contains brackets", () => {
    // The prose has a bracket but the real array comes later
    const input = `Result (see step 3): [{"id":"t1","task":"Real task"},{"id":"t2","task":"Another"}]`;
    const result = parseDecomposeResponse(input);
    // Strategy 2 greedily matches from first [ to last ] — should find a valid array
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── buildSynthesisTask — boundary conditions ─────────────────────────────────

describe("buildSynthesisTask - boundary conditions", () => {
  it("handles empty outputs array (zero sub-tasks completed)", () => {
    const tasks = [{ id: "task-1", task: "Something" }];
    const result = buildSynthesisTask("My goal", tasks, [], "out.md");
    expect(result).toContain("My goal");
    expect(result).toContain("0 sub-tasks");
    expect(result).toContain("out.md");
  });

  it("handles empty tasks and outputs arrays", () => {
    const result = buildSynthesisTask("Minimal goal", [], [], "minimal.md");
    expect(result).toContain("Minimal goal");
    expect(result).toContain("minimal.md");
  });

  it("shows truncation annotation when output exceeds 500 lines", () => {
    const manyLines = Array.from({ length: 600 }, (_, i) => `line-${i}`);
    const tasks = [{ id: "task-1", task: "Heavy task" }];
    const outputs = [
      { taskId: "task-1", task: "Heavy task", status: "done", lines: manyLines },
    ];
    const result = buildSynthesisTask("Goal", tasks, outputs, "out.md");
    expect(result).toContain("showing last 500");
    // line-0 through line-99 should be dropped (only last 500 kept)
    expect(result).not.toContain("line-0\n");
    expect(result).toContain("line-599");
  });

  it("does not show truncation annotation when output is exactly 500 lines", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`);
    const tasks = [{ id: "task-1", task: "Task" }];
    const outputs = [{ taskId: "task-1", task: "Task", status: "done", lines }];
    const result = buildSynthesisTask("Goal", tasks, outputs, "out.md");
    expect(result).not.toContain("showing last 500");
    expect(result).toContain(`500 total lines`);
  });

  it("truncates goal to 60 chars in the PR title line", () => {
    const longGoal = "A".repeat(80);
    const result = buildSynthesisTask(longGoal, [], [], "out.md");
    // The template: `"swarm synthesis: ${goal.slice(0, 60)}"`
    expect(result).toContain("swarm synthesis: " + "A".repeat(60));
    expect(result).not.toContain("swarm synthesis: " + "A".repeat(61));
  });

  it("goal exactly 60 chars appears untruncated in PR title", () => {
    const goal60 = "B".repeat(60);
    const result = buildSynthesisTask(goal60, [], [], "out.md");
    expect(result).toContain("swarm synthesis: " + "B".repeat(60));
  });

  it("includes status for each sub-task output", () => {
    const tasks = [
      { id: "t1", task: "Task one" },
      { id: "t2", task: "Task two" },
    ];
    const outputs = [
      { taskId: "t1", task: "Task one", status: "done", lines: ["ok"] },
      { taskId: "t2", task: "Task two", status: "cancelled", lines: [] },
    ];
    const result = buildSynthesisTask("Goal", tasks, outputs, "out.md");
    expect(result).toContain("Status: done");
    expect(result).toContain("Status: cancelled");
  });

  it("char-truncation for output exceeding 20000 chars produces valid result", () => {
    // Each line is 100 chars; 300 lines = 30000 chars (> MAX_OUTPUT_CHARS=20000)
    const longLines = Array.from({ length: 300 }, (_, i) =>
      `line-${String(i).padStart(3, "0")}-${"x".repeat(93)}`
    );
    const tasks = [{ id: "t1", task: "Task" }];
    const outputs = [{ taskId: "t1", task: "Task", status: "done", lines: longLines }];
    const result = buildSynthesisTask("Goal", tasks, outputs, "out.md");
    // Result should be a non-empty string (no crash)
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("Goal");
  });
});
