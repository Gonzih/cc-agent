import { describe, it, expect } from "vitest";
import { buildEvaluatorTask } from "./evaluator.js";
import type { EvaluatorOptions } from "./evaluator.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeOpts(overrides: Partial<EvaluatorOptions> = {}): EvaluatorOptions {
  return {
    variantJobIds: ["job-a", "job-b"],
    variantBranches: ["feat/a", "feat/b"],
    branchEval: "test_pass_rate",
    branchSelect: "best_score",
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

// ─── buildEvaluatorTask — structural checks ───────────────────────────────────

describe("buildEvaluatorTask", () => {
  it("includes the step ID in the header", () => {
    const result = buildEvaluatorTask(makeOpts({ stepId: "step-42" }));
    expect(result).toContain("step-42");
  });

  it("includes all variant job IDs in the list", () => {
    const result = buildEvaluatorTask(makeOpts());
    expect(result).toContain("job-a");
    expect(result).toContain("job-b");
  });

  it("includes branch names when provided", () => {
    const result = buildEvaluatorTask(makeOpts({ variantBranches: ["feat/x", "feat/y"] }));
    expect(result).toContain("feat/x");
    expect(result).toContain("feat/y");
  });

  it("omits branch= when branch is undefined", () => {
    const result = buildEvaluatorTask(
      makeOpts({ variantBranches: [undefined, undefined] })
    );
    // Should not contain "branch=" anywhere in the variant list section
    const variantSection = result.split("## Evaluation Instructions")[0];
    expect(variantSection).not.toContain("branch=");
  });

  it("labels variants with sequential numbers", () => {
    const result = buildEvaluatorTask(makeOpts());
    expect(result).toContain("Variant 1");
    expect(result).toContain("Variant 2");
  });

  it("includes set_job_score instruction for all variants", () => {
    const result = buildEvaluatorTask(makeOpts());
    expect(result).toContain("set_job_score");
  });

  it("includes WINNER output format", () => {
    const result = buildEvaluatorTask(makeOpts());
    expect(result).toContain("WINNER:");
    expect(result).toContain("job_id");
    expect(result).toContain("variant_index");
    expect(result).toContain("score");
    expect(result).toContain("reason");
  });

  it("correctly counts variants in header", () => {
    const threeVariants = makeOpts({
      variantJobIds: ["j1", "j2", "j3"],
      variantBranches: ["b1", "b2", "b3"],
    });
    const result = buildEvaluatorTask(threeVariants);
    expect(result).toContain("evaluate 3 variant");
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

describe("buildEvaluatorTask — branchEval: test_pass_rate", () => {
  it("includes test pass rate scoring formula", () => {
    const result = buildEvaluatorTask(makeOpts({ branchEval: "test_pass_rate" }));
    expect(result).toContain("pass_rate");
    expect(result).toContain("exitCode");
    expect(result).toContain("0.7");
    expect(result).toContain("0.3");
  });

  it("includes instructions to search for test result patterns", () => {
    const result = buildEvaluatorTask(makeOpts({ branchEval: "test_pass_rate" }));
    expect(result).toContain("passing");
    expect(result).toContain("failing");
  });
});

describe("buildEvaluatorTask — branchEval: pr_merged", () => {
  it("includes PR merged scoring instructions", () => {
    const result = buildEvaluatorTask(makeOpts({ branchEval: "pr_merged" }));
    expect(result).toContain("pr_merged");
    expect(result).toContain("1.0");
    expect(result).toContain("0.5");
  });

  it("mentions PR URL retrieval", () => {
    const result = buildEvaluatorTask(makeOpts({ branchEval: "pr_merged" }));
    expect(result).toContain("PR");
  });
});

describe("buildEvaluatorTask — branchEval: manual", () => {
  it("includes manual evaluation instructions", () => {
    const result = buildEvaluatorTask(makeOpts({ branchEval: "manual" }));
    expect(result).toContain("manually");
    expect(result).toContain("0.0 to 1.0");
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

describe("buildEvaluatorTask — branchSelect: best_score", () => {
  it("instructs to pick the highest score", () => {
    const result = buildEvaluatorTask(makeOpts({ branchSelect: "best_score" }));
    expect(result).toContain("highest score");
  });

  it("instructs to break ties by lowest variant index", () => {
    const result = buildEvaluatorTask(makeOpts({ branchSelect: "best_score" }));
    expect(result).toContain("tie");
  });
});

describe("buildEvaluatorTask — branchSelect: score_prop", () => {
  it("includes roulette wheel selection description", () => {
    const result = buildEvaluatorTask(makeOpts({ branchSelect: "score_prop" }));
    expect(result).toContain("score-proportional");
    expect(result).toContain("roulette");
  });

  it("includes uniform fallback when all scores are zero", () => {
    const result = buildEvaluatorTask(makeOpts({ branchSelect: "score_prop" }));
    expect(result).toContain("all scores are 0");
  });

  it("includes variant count in the uniform fallback formula", () => {
    const twoVariants = makeOpts({ branchSelect: "score_prop" });
    const result = buildEvaluatorTask(twoVariants);
    expect(result).toContain("1/2");
  });
});

describe("buildEvaluatorTask — branchSelect: latest", () => {
  it("instructs to select most recently completed variant", () => {
    const result = buildEvaluatorTask(makeOpts({ branchSelect: "latest" }));
    expect(result).toContain("most recent");
  });

  it("instructs to fall back to highest variant index on tie", () => {
    const result = buildEvaluatorTask(makeOpts({ branchSelect: "latest" }));
    expect(result).toContain("highest variant index");
  });
});

// ─── edge cases ───────────────────────────────────────────────────────────────

describe("buildEvaluatorTask — edge cases", () => {
  it("works with a single variant", () => {
    const result = buildEvaluatorTask(
      makeOpts({ variantJobIds: ["solo-job"], variantBranches: ["feat/solo"] })
    );
    expect(result).toContain("solo-job");
    expect(result).toContain("Variant 1");
    expect(result).not.toContain("Variant 2");
  });

  it("note instructs to call set_job_score for ALL variants including 0.0", () => {
    const result = buildEvaluatorTask(makeOpts());
    expect(result).toContain("ALL variants");
    expect(result).toContain("0.0");
  });

  it("fallback policy when all variants scored 0.0", () => {
    const result = buildEvaluatorTask(makeOpts());
    expect(result).toContain("all variants scored 0.0");
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
