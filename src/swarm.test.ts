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
