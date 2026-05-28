import { describe, it, expect } from "vitest";
import { parseWorkflowResponse, validateStages, WORKFLOW_MAX_STAGES_HARD_CAP } from "./workflow.js";

// ─── WORKFLOW_MAX_STAGES_HARD_CAP ─────────────────────────────────────────────

describe("WORKFLOW_MAX_STAGES_HARD_CAP", () => {
  it("is 20", () => {
    expect(WORKFLOW_MAX_STAGES_HARD_CAP).toBe(20);
  });
});

// ─── parseWorkflowResponse ────────────────────────────────────────────────────

describe("parseWorkflowResponse", () => {
  it("parses a clean JSON array of stages", () => {
    const input = JSON.stringify([
      { stage: 1, steps: [{ id: "s1-build", task: "Build the project" }] },
      { stage: 2, steps: [{ id: "s2-test", task: "Run tests" }, { id: "s2-lint", task: "Run linter" }] },
    ]);
    const result = parseWorkflowResponse(input);
    expect(result).toHaveLength(2);
    expect(result[0].stage).toBe(1);
    expect(result[0].steps).toHaveLength(1);
    expect(result[0].steps[0].task).toBe("Build the project");
    expect(result[1].steps).toHaveLength(2);
  });

  it("extracts JSON array embedded in prose text", () => {
    const input = `Here is the workflow breakdown:\n\n[{"stage":1,"steps":[{"id":"s1-a","task":"Do setup"}]}]\n\nGood luck!`;
    const result = parseWorkflowResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].steps[0].task).toBe("Do setup");
  });

  it("extracts JSON array from markdown code fence", () => {
    const inner = JSON.stringify([
      { stage: 1, steps: [{ id: "s1-init", task: "Initialize repo" }] },
      { stage: 2, steps: [{ id: "s2-impl", task: "Implement feature" }] },
    ]);
    const input = `Here is the plan:\n\`\`\`json\n${inner}\n\`\`\``;
    const result = parseWorkflowResponse(input);
    expect(result).toHaveLength(2);
    expect(result[0].steps[0].id).toBe("s1-init");
  });

  it("throws on completely invalid JSON", () => {
    expect(() => parseWorkflowResponse("not json at all")).toThrow();
  });

  it("throws on empty string", () => {
    expect(() => parseWorkflowResponse("")).toThrow();
  });

  it("throws when input is a JSON object not an array", () => {
    expect(() => parseWorkflowResponse('{"stage":1,"steps":"none"}')).toThrow(
      /Cannot extract JSON array/,
    );
  });

  it("sorts stages by stage number even if returned out of order", () => {
    const input = JSON.stringify([
      { stage: 3, steps: [{ id: "s3-deploy", task: "Deploy" }] },
      { stage: 1, steps: [{ id: "s1-build", task: "Build" }] },
      { stage: 2, steps: [{ id: "s2-test", task: "Test" }] },
    ]);
    const result = parseWorkflowResponse(input);
    expect(result[0].stage).toBe(1);
    expect(result[1].stage).toBe(2);
    expect(result[2].stage).toBe(3);
  });

  it("filters out stages with no valid steps", () => {
    const input = JSON.stringify([
      { stage: 1, steps: [{ id: "s1-a", task: "Valid task" }] },
      { stage: 2, steps: [{ id: "s2-a", task: "   " }] }, // whitespace-only task
    ]);
    const result = parseWorkflowResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].stage).toBe(1);
  });

  it("filters out items missing 'stage' or 'steps' fields", () => {
    const input = JSON.stringify([
      { stage: 1, steps: [{ id: "s1-a", task: "Valid" }] },
      { notStage: 2, steps: [] },
      { stage: 3 }, // missing steps
    ]);
    const result = parseWorkflowResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].stage).toBe(1);
  });
});

// ─── validateStages ───────────────────────────────────────────────────────────

describe("validateStages", () => {
  it("auto-generates step id when missing or empty", () => {
    const arr = [
      { stage: 1, steps: [{ task: "Task A" }, { id: "", task: "Task B" }] },
    ];
    const result = validateStages(arr);
    expect(result[0].steps[0].id).toBe("s1-1");
    expect(result[0].steps[1].id).toBe("s1-2");
  });

  it("preserves depends_on array on steps", () => {
    const arr = [
      { stage: 1, steps: [{ id: "s1-a", task: "Task A" }] },
      { stage: 2, steps: [{ id: "s2-b", task: "Task B", depends_on: ["s1-a"] }] },
    ];
    const result = validateStages(arr);
    expect(result[1].steps[0].depends_on).toEqual(["s1-a"]);
  });

  it("filters null and primitive items, keeps only valid stage objects", () => {
    const arr = [null, 42, "str", { stage: 1, steps: [{ id: "s1-x", task: "Valid" }] }];
    const result = validateStages(arr as unknown[]);
    expect(result).toHaveLength(1);
    expect(result[0].steps[0].task).toBe("Valid");
  });

  it("returns empty array for empty input", () => {
    expect(validateStages([])).toHaveLength(0);
  });

  it("coerces numeric task field to string", () => {
    const arr = [{ stage: 1, steps: [{ id: "s1-a", task: 123 }] }];
    const result = validateStages(arr as unknown[]);
    expect(result[0].steps[0].task).toBe("123");
  });

  it("does not include depends_on field when absent", () => {
    const arr = [{ stage: 1, steps: [{ id: "s1-a", task: "Task" }] }];
    const result = validateStages(arr);
    expect(result[0].steps[0].depends_on).toBeUndefined();
  });
});

// ─── parseWorkflowResponse — boundary conditions ──────────────────────────────

describe("parseWorkflowResponse - boundary conditions", () => {
  it("handles a single-stage workflow", () => {
    const input = JSON.stringify([
      { stage: 1, steps: [{ id: "s1-only", task: "Do everything" }] },
    ]);
    const result = parseWorkflowResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].stage).toBe(1);
    expect(result[0].steps[0].task).toBe("Do everything");
  });

  it("handles many parallel steps in one stage", () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({
      id: `s1-${i + 1}`,
      task: `Parallel task ${i + 1}`,
    }));
    const input = JSON.stringify([{ stage: 1, steps }]);
    const result = parseWorkflowResponse(input);
    expect(result[0].steps).toHaveLength(10);
  });

  it("returns empty array for an empty JSON array", () => {
    const result = parseWorkflowResponse("[]");
    expect(result).toHaveLength(0);
  });

  it("throws when JSON code fence is unclosed and no other valid JSON found", () => {
    expect(() => parseWorkflowResponse("```json\n[{broken")).toThrow();
  });
});
