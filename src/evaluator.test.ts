import { describe, it, expect } from "vitest";
import { buildEvaluatorTask } from "./evaluator.js";
import type { EvaluatorOptions } from "./evaluator.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOpts(overrides: Partial<EvaluatorOptions> = {}): EvaluatorOptions {
  return {
    variantJobIds: ["job-a", "job-b"],
    variantBranches: [undefined, undefined],
    branchEval: "test_pass_rate",
    branchSelect: "best_score",
    stepId: "step-1",
    ...overrides,
  };
}

// ─── buildEvaluatorTask — structure ──────────────────────────────────────────

describe("buildEvaluatorTask — structure", () => {
  it("includes the step ID in the header", () => {
    const task = buildEvaluatorTask(makeOpts({ stepId: "my-step" }));
    expect(task).toContain("my-step");
  });

  it("includes the correct variant count", () => {
    const task = buildEvaluatorTask(makeOpts({ variantJobIds: ["j1", "j2", "j3"] }));
    expect(task).toContain("3");
  });

  it("lists all variant job IDs", () => {
    const task = buildEvaluatorTask(makeOpts({ variantJobIds: ["job-x", "job-y"] }));
    expect(task).toContain("job-x");
    expect(task).toContain("job-y");
  });

  it("labels variants with 1-based index", () => {
    const task = buildEvaluatorTask(makeOpts({ variantJobIds: ["j1", "j2"] }));
    expect(task).toContain("Variant 1");
    expect(task).toContain("Variant 2");
  });

  it("includes branch name when variant has a branch", () => {
    const task = buildEvaluatorTask(
      makeOpts({
        variantJobIds: ["job-a", "job-b"],
        variantBranches: ["feat/branch-a", undefined],
      })
    );
    expect(task).toContain("feat/branch-a");
    // job-b has no branch — should not appear with a branch= segment
    const lines = task.split("\n");
    const jobBLine = lines.find((l) => l.includes("job-b"));
    expect(jobBLine).toBeDefined();
    expect(jobBLine).not.toContain("branch=");
  });

  it("omits branch segment when variant branch is undefined", () => {
    const task = buildEvaluatorTask(
      makeOpts({ variantJobIds: ["job-c"], variantBranches: [undefined] })
    );
    const lines = task.split("\n");
    const variantLine = lines.find((l) => l.includes("job-c"));
    expect(variantLine).toBeDefined();
    expect(variantLine).not.toContain("branch=");
  });

  it("instructs to call set_job_score for ALL variants", () => {
    const task = buildEvaluatorTask(makeOpts());
    expect(task).toContain("set_job_score");
    expect(task).toContain("ALL variants");
  });

  it("includes WINNER output format on its own line", () => {
    const task = buildEvaluatorTask(makeOpts());
    expect(task).toMatch(/^WINNER:/m);
    expect(task).toContain('"job_id"');
    expect(task).toContain('"variant_index"');
    expect(task).toContain('"score"');
    expect(task).toContain('"reason"');
  });

  it("works with a single variant", () => {
    const task = buildEvaluatorTask(
      makeOpts({ variantJobIds: ["solo-job"], variantBranches: ["main"] })
    );
    expect(task).toContain("solo-job");
    expect(task).toContain("Variant 1");
    expect(task).not.toContain("Variant 2");
  });

  it("works with many variants", () => {
    const ids = Array.from({ length: 5 }, (_, i) => `job-${i}`);
    const branches = ids.map(() => undefined);
    const task = buildEvaluatorTask(makeOpts({ variantJobIds: ids, variantBranches: branches }));
    for (let i = 1; i <= 5; i++) {
      expect(task).toContain(`Variant ${i}`);
    }
  });
});

// ─── buildEvaluatorTask — branchEval ─────────────────────────────────────────

describe("buildEvaluatorTask — branchEval", () => {
  it("test_pass_rate: mentions pass rate calculation and patterns", () => {
    const task = buildEvaluatorTask(makeOpts({ branchEval: "test_pass_rate" }));
    expect(task).toContain("pass rate");
    expect(task).toContain("passing");
    expect(task).toContain("failing");
  });

  it("test_pass_rate: scoring formula is present (0.7 weight for pass rate)", () => {
    const task = buildEvaluatorTask(makeOpts({ branchEval: "test_pass_rate" }));
    expect(task).toContain("0.7");
  });

  it("pr_merged: mentions PR merged status check", () => {
    const task = buildEvaluatorTask(makeOpts({ branchEval: "pr_merged" }));
    expect(task).toContain("merged");
    expect(task).toContain("PR");
  });

  it("pr_merged: scoring is 1.0 for merged, 0.5 for created, 0.0 otherwise", () => {
    const task = buildEvaluatorTask(makeOpts({ branchEval: "pr_merged" }));
    expect(task).toContain("1.0");
    expect(task).toContain("0.5");
    expect(task).toContain("0.0");
  });

  it("manual: asks for qualitative assessment", () => {
    const task = buildEvaluatorTask(makeOpts({ branchEval: "manual" }));
    expect(task).toContain("quality");
    expect(task).toContain("0.0 to 1.0");
  });

  it("manual: does not mention test pass rate formula", () => {
    const task = buildEvaluatorTask(makeOpts({ branchEval: "manual" }));
    expect(task).not.toContain("pass_rate * 0.7");
  });
});

// ─── buildEvaluatorTask — branchSelect ───────────────────────────────────────

describe("buildEvaluatorTask — branchSelect", () => {
  it("best_score: selects highest score variant", () => {
    const task = buildEvaluatorTask(makeOpts({ branchSelect: "best_score" }));
    expect(task).toContain("highest score");
  });

  it("best_score: tie-breaking by lowest variant index", () => {
    const task = buildEvaluatorTask(makeOpts({ branchSelect: "best_score" }));
    expect(task).toContain("tie");
    expect(task).toContain("lowest variant index");
  });

  it("score_prop: describes roulette wheel selection", () => {
    const task = buildEvaluatorTask(makeOpts({ branchSelect: "score_prop" }));
    expect(task).toContain("roulette wheel");
  });

  it("score_prop: includes uniform probability fallback when all scores are 0", () => {
    const task = buildEvaluatorTask(
      makeOpts({ branchSelect: "score_prop", variantJobIds: ["a", "b", "c"] })
    );
    expect(task).toContain("all scores are 0");
    // 1/3 (uniform) — check the denominator matches variant count
    expect(task).toContain("1/3");
  });

  it("latest: selects most recently completed variant", () => {
    const task = buildEvaluatorTask(makeOpts({ branchSelect: "latest" }));
    expect(task).toContain("most recent");
  });

  it("latest: fallback to highest variant index", () => {
    const task = buildEvaluatorTask(makeOpts({ branchSelect: "latest" }));
    expect(task).toContain("highest variant index");
  });
});

// ─── buildEvaluatorTask — all branchEval × branchSelect combinations ─────────

describe("buildEvaluatorTask — all 9 eval×select combinations", () => {
  const evalTypes = ["test_pass_rate", "pr_merged", "manual"] as const;
  const selectTypes = ["best_score", "score_prop", "latest"] as const;

  for (const branchEval of evalTypes) {
    for (const branchSelect of selectTypes) {
      it(`produces non-empty task for ${branchEval} × ${branchSelect}`, () => {
        const task = buildEvaluatorTask(makeOpts({ branchEval, branchSelect }));
        expect(typeof task).toBe("string");
        expect(task.length).toBeGreaterThan(100);
        // Every combination must reference get_job_output (for reading variant output)
        expect(task).toContain("get_job_output");
        // WINNER format always required
        expect(task).toMatch(/^WINNER:/m);
      });
    }
  }
});
