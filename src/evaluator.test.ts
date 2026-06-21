import { describe, it, expect } from "vitest";
import { buildEvaluatorTask } from "./evaluator.js";
import type { BranchEval, BranchSelect } from "./evaluator.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeOpts(overrides: Partial<Parameters<typeof buildEvaluatorTask>[0]> = {}) {
  return {
    variantJobIds: ["job-a", "job-b"],
    variantBranches: ["feat-v1", "feat-v2"] as (string | undefined)[],
    branchEval: "test_pass_rate" as BranchEval,
    branchSelect: "best_score" as BranchSelect,
    stepId: "step-1",
    ...overrides,
  };
}

// ─── Core structure ───────────────────────────────────────────────────────────

describe("buildEvaluatorTask — core structure", () => {
  it("includes the step ID", () => {
    const task = buildEvaluatorTask(makeOpts({ stepId: "my-step-id" }));
    expect(task).toContain("my-step-id");
  });

  it("includes all variant job IDs", () => {
    const task = buildEvaluatorTask(makeOpts({ variantJobIds: ["alpha", "beta", "gamma"] }));
    expect(task).toContain("alpha");
    expect(task).toContain("beta");
    expect(task).toContain("gamma");
  });

  it("includes branch names when provided", () => {
    const task = buildEvaluatorTask(makeOpts({ variantBranches: ["feature-v1", "feature-v2"] }));
    expect(task).toContain("feature-v1");
    expect(task).toContain("feature-v2");
  });

  it("omits branch field when branch is undefined", () => {
    const task = buildEvaluatorTask(makeOpts({ variantBranches: [undefined, undefined] }));
    expect(task).not.toContain("branch=");
  });

  it("includes mixed branches (some defined, some undefined)", () => {
    const task = buildEvaluatorTask(makeOpts({
      variantJobIds: ["j1", "j2"],
      variantBranches: ["main-v1", undefined],
    }));
    expect(task).toContain("main-v1");
    expect(task).not.toContain("branch=undefined");
  });

  it("includes the WINNER output format marker", () => {
    const task = buildEvaluatorTask(makeOpts());
    expect(task).toContain("WINNER:");
  });

  it("includes set_job_score instruction", () => {
    const task = buildEvaluatorTask(makeOpts());
    expect(task).toContain("set_job_score");
  });

  it("mentions the correct variant count", () => {
    const task = buildEvaluatorTask(makeOpts({ variantJobIds: ["j1", "j2", "j3"] }));
    expect(task).toContain("3");
  });

  it("mentions scoring range 0.0 to 1.0", () => {
    const task = buildEvaluatorTask(makeOpts());
    expect(task).toContain("0.0");
    expect(task).toContain("1.0");
  });

  it("includes get_job_output instruction for reading variant output", () => {
    const task = buildEvaluatorTask(makeOpts());
    expect(task).toContain("get_job_output");
  });

  it("includes failed variant score instruction (score 0.0)", () => {
    const task = buildEvaluatorTask(makeOpts());
    expect(task).toContain("failed");
    expect(task).toContain("0.0");
  });

  it("produces a non-empty string", () => {
    const task = buildEvaluatorTask(makeOpts());
    expect(task.length).toBeGreaterThan(100);
  });
});

// ─── Single variant edge case ─────────────────────────────────────────────────

describe("buildEvaluatorTask — single variant", () => {
  it("works without error", () => {
    const task = buildEvaluatorTask({
      variantJobIds: ["solo-job"],
      variantBranches: ["main"],
      branchEval: "test_pass_rate",
      branchSelect: "best_score",
      stepId: "solo-step",
    });
    expect(task).toContain("solo-job");
    expect(task).toContain("WINNER:");
  });
});

// ─── Many variants ────────────────────────────────────────────────────────────

describe("buildEvaluatorTask — many variants", () => {
  it("lists all job IDs for 5 variants", () => {
    const ids = Array.from({ length: 5 }, (_, i) => `job-${i}`);
    const branches = ids.map((_, i) => `branch-${i}`);
    const task = buildEvaluatorTask({
      variantJobIds: ids,
      variantBranches: branches,
      branchEval: "pr_merged",
      branchSelect: "score_prop",
      stepId: "big-step",
    });
    for (const id of ids) {
      expect(task).toContain(id);
    }
  });
});

// ─── branchEval modes ─────────────────────────────────────────────────────────

describe("buildEvaluatorTask — branchEval modes", () => {
  it("test_pass_rate: includes pass rate fraction formula", () => {
    const task = buildEvaluatorTask(makeOpts({ branchEval: "test_pass_rate" }));
    expect(task).toContain("pass");
    // The formula weights pass rate at 0.7
    expect(task).toContain("0.7");
  });

  it("test_pass_rate: mentions exitCode", () => {
    const task = buildEvaluatorTask(makeOpts({ branchEval: "test_pass_rate" }));
    expect(task).toContain("exitCode");
  });

  it("pr_merged: includes PR merged check logic", () => {
    const task = buildEvaluatorTask(makeOpts({ branchEval: "pr_merged" }));
    expect(task).toContain("merged");
  });

  it("pr_merged: assigns 1.0 for merged, 0.5 for PR created", () => {
    const task = buildEvaluatorTask(makeOpts({ branchEval: "pr_merged" }));
    expect(task).toContain("1.0");
    expect(task).toContain("0.5");
  });

  it("manual: includes manual assessment instruction", () => {
    const task = buildEvaluatorTask(makeOpts({ branchEval: "manual" }));
    expect(task).toContain("manually");
  });

  it("manual: asks for score 0.0 to 1.0", () => {
    const task = buildEvaluatorTask(makeOpts({ branchEval: "manual" }));
    expect(task).toContain("0.0");
    expect(task).toContain("1.0");
  });
});

// ─── branchSelect modes ───────────────────────────────────────────────────────

describe("buildEvaluatorTask — branchSelect modes", () => {
  it("best_score: instructs picking variant with highest score", () => {
    const task = buildEvaluatorTask(makeOpts({ branchSelect: "best_score" }));
    expect(task).toContain("highest score");
  });

  it("best_score: mentions tie-breaking by lowest variant index", () => {
    const task = buildEvaluatorTask(makeOpts({ branchSelect: "best_score" }));
    expect(task).toContain("tie");
  });

  it("score_prop: includes probability-based selection", () => {
    const task = buildEvaluatorTask(makeOpts({ branchSelect: "score_prop" }));
    expect(task).toContain("probability");
  });

  it("score_prop: describes uniform fallback when all scores are 0", () => {
    const task = buildEvaluatorTask(makeOpts({ branchSelect: "score_prop" }));
    expect(task).toContain("all scores are 0");
  });

  it("score_prop: includes the variant count as uniform denominator", () => {
    const task = buildEvaluatorTask(makeOpts({ branchSelect: "score_prop", variantJobIds: ["j1", "j2"] }));
    expect(task).toContain("1/2");
  });

  it("latest: instructs picking most recent completion", () => {
    const task = buildEvaluatorTask(makeOpts({ branchSelect: "latest" }));
    expect(task).toContain("recent");
  });

  it("latest: uses highest variant index as tiebreaker", () => {
    const task = buildEvaluatorTask(makeOpts({ branchSelect: "latest" }));
    expect(task).toContain("highest variant index");
  });
});

// ─── Output is deterministic ──────────────────────────────────────────────────

describe("buildEvaluatorTask — determinism", () => {
  it("same input produces identical output on repeated calls", () => {
    const opts = makeOpts();
    const first = buildEvaluatorTask(opts);
    const second = buildEvaluatorTask(opts);
    expect(first).toBe(second);
  });

  it("different stepIds produce different output", () => {
    const a = buildEvaluatorTask(makeOpts({ stepId: "step-a" }));
    const b = buildEvaluatorTask(makeOpts({ stepId: "step-b" }));
    expect(a).not.toBe(b);
  });

  it("different branchEvals produce different output", () => {
    const a = buildEvaluatorTask(makeOpts({ branchEval: "test_pass_rate" }));
    const b = buildEvaluatorTask(makeOpts({ branchEval: "pr_merged" }));
    expect(a).not.toBe(b);
  });
});
