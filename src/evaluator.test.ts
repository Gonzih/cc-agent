import { describe, it, expect } from "vitest";
import { buildEvaluatorTask } from "./evaluator.js";
import type { EvaluatorOptions } from "./evaluator.js";

const BASE_OPTS: EvaluatorOptions = {
  variantJobIds: ["job-1", "job-2"],
  variantBranches: ["feat/v1", undefined],
  branchEval: "test_pass_rate",
  branchSelect: "best_score",
  stepId: "step-0",
};

describe("buildEvaluatorTask", () => {
  it("includes the step ID", () => {
    const out = buildEvaluatorTask(BASE_OPTS);
    expect(out).toContain("step: step-0");
  });

  it("mentions the variant count", () => {
    const out = buildEvaluatorTask(BASE_OPTS);
    expect(out).toContain("evaluate 2 variant");
  });

  it("lists all variant job IDs", () => {
    const out = buildEvaluatorTask(BASE_OPTS);
    expect(out).toContain("job_id=job-1");
    expect(out).toContain("job_id=job-2");
  });

  it("includes branch when provided", () => {
    const out = buildEvaluatorTask(BASE_OPTS);
    expect(out).toContain("branch=feat/v1");
  });

  it("omits branch field for undefined branches", () => {
    const out = buildEvaluatorTask(BASE_OPTS);
    // Variant 2 has no branch — should not emit "branch=undefined"
    expect(out).not.toContain("branch=undefined");
  });

  it("includes WINNER output format", () => {
    const out = buildEvaluatorTask(BASE_OPTS);
    expect(out).toContain("WINNER:");
    expect(out).toContain('"job_id"');
    expect(out).toContain('"score"');
  });

  it("reminds to call set_job_score for all variants", () => {
    const out = buildEvaluatorTask(BASE_OPTS);
    expect(out).toContain("set_job_score");
  });

  // --- branchEval variants ---

  it("test_pass_rate: includes pass rate scoring instructions", () => {
    const out = buildEvaluatorTask({ ...BASE_OPTS, branchEval: "test_pass_rate" });
    expect(out).toContain("pass_rate");
    expect(out).toContain("passing_tests");
    expect(out).toContain("exitCode");
  });

  it("pr_merged: includes PR merge scoring instructions", () => {
    const out = buildEvaluatorTask({ ...BASE_OPTS, branchEval: "pr_merged" });
    expect(out).toContain("pr_merged");
    expect(out).toContain("pr_created");
  });

  it("manual: includes manual review scoring instructions", () => {
    const out = buildEvaluatorTask({ ...BASE_OPTS, branchEval: "manual" });
    expect(out).toContain("quality");
    expect(out).toContain("completeness");
  });

  // --- branchSelect variants ---

  it("best_score: selects highest scoring variant", () => {
    const out = buildEvaluatorTask({ ...BASE_OPTS, branchSelect: "best_score" });
    expect(out).toContain("highest score");
  });

  it("score_prop: describes roulette wheel selection with correct uniform probability", () => {
    const out = buildEvaluatorTask({
      ...BASE_OPTS,
      branchSelect: "score_prop",
      variantJobIds: ["a", "b", "c"],
      variantBranches: [undefined, undefined, undefined],
    });
    expect(out).toContain("score-proportional");
    expect(out).toContain("1/3");
  });

  it("latest: selects most recently completed variant", () => {
    const out = buildEvaluatorTask({ ...BASE_OPTS, branchSelect: "latest" });
    expect(out).toContain("recent completion time");
  });

  // --- edge cases ---

  it("works with a single variant and no branch", () => {
    const out = buildEvaluatorTask({
      variantJobIds: ["solo-job"],
      variantBranches: [undefined],
      branchEval: "manual",
      branchSelect: "latest",
      stepId: "s1",
    });
    expect(out).toContain("job_id=solo-job");
    expect(out).toContain("evaluate 1 variant");
    expect(out).toContain("step: s1");
  });

  it("numbers variants starting from 1", () => {
    const out = buildEvaluatorTask(BASE_OPTS);
    expect(out).toContain("Variant 1:");
    expect(out).toContain("Variant 2:");
  });

  it("returns a non-empty string", () => {
    const out = buildEvaluatorTask(BASE_OPTS);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(100);
  });
});
