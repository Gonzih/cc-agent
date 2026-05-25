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
  });
});
