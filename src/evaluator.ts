/**
 * Evaluator job template — generates task text for evaluator jobs in evolutionary plans.
 */

export type BranchEval = "test_pass_rate" | "pr_merged" | "manual";
export type BranchSelect = "best_score" | "score_prop" | "latest";

export interface EvaluatorOptions {
  variantJobIds: string[];
  variantBranches: (string | undefined)[];
  branchEval: BranchEval;
  branchSelect: BranchSelect;
  stepId: string;
}

export function buildEvaluatorTask(opts: EvaluatorOptions): string {
  const { variantJobIds, variantBranches, branchEval, branchSelect, stepId } = opts;

  const variantList = variantJobIds
    .map((id, i) => `  - Variant ${i + 1}: job_id=${id}${variantBranches[i] ? `, branch=${variantBranches[i]}` : ""}`)
    .join("\n");

  const evalInstructions = buildEvalInstructions(branchEval);
  const selectInstructions = buildSelectInstructions(branchSelect, variantJobIds.length);

  return `You are an evaluator agent for an evolutionary branching plan (step: ${stepId}).

Your job is to evaluate ${variantJobIds.length} variant solutions, score them, and select the best one.

## Variants to Evaluate

${variantList}

## Evaluation Instructions

${evalInstructions}

## Scoring

For each variant, compute a score from 0.0 to 1.0:
- Check the job output using get_job_output for each variant job_id
- ${branchEval === "test_pass_rate" ? "Parse test results: look for patterns like 'X passing', 'X tests passed', 'X failed'. Score = (passing / (passing + failing)) * 0.7 + (exitCode === 0 ? 0.3 : 0)" : ""}
- ${branchEval === "pr_merged" ? "Check if a PR was merged: score = pr_merged ? 1.0 : (pr_exists ? 0.5 : 0.0)" : ""}
- ${branchEval === "manual" ? "Review the output quality manually and assign a score from 0.0 to 1.0 based on completeness and correctness" : ""}
- If a variant failed (status=failed or non-zero exit), score it 0.0

After computing each score, call set_job_score with the job_id and computed score.

## Winner Selection

${selectInstructions}

## Output

After evaluating all variants and calling set_job_score for each, output a JSON block exactly like this (on its own line):

WINNER: {"job_id": "<winning_job_id>", "variant_index": <N>, "branch": "<branch_or_null>", "score": <score>, "reason": "<brief reason>"}

This line will be parsed by downstream jobs to know which variant won.

## Important Notes

- Always call set_job_score for ALL variants, even if they scored 0.0
- Be objective in your evaluation
- If all variants scored 0.0, pick the one with the least errors or pick variant 1
`;
}

function buildEvalInstructions(branchEval: BranchEval): string {
  switch (branchEval) {
    case "test_pass_rate":
      return `For each variant job:
1. Call get_job_output with the variant's job_id
2. Search output for test result patterns: "X passing", "X tests passed", "X failed", "X failures"
3. Calculate pass rate = passing_tests / (passing_tests + failing_tests)
4. Check job exit code (exitCode=0 means success, non-zero means failure)
5. Score = pass_rate * 0.7 + (exitCode === 0 ? 0.3 : 0)`;

    case "pr_merged":
      return `For each variant job:
1. Call get_job_output with the variant's job_id to find the PR URL
2. Check if the PR was merged by looking for "merged" status in the output
3. Score = pr_merged ? 1.0 : (pr_created ? 0.5 : 0.0)`;

    case "manual":
      return `For each variant job:
1. Call get_job_output with the variant's job_id to review the full output
2. Assess the quality, completeness, and correctness of the work
3. Assign a score from 0.0 to 1.0 based on your assessment`;
  }
}

function buildSelectInstructions(branchSelect: BranchSelect, variantCount: number): string {
  switch (branchSelect) {
    case "best_score":
      return `Select the variant with the highest score. If there is a tie, pick the lowest variant index.`;

    case "score_prop":
      return `Select a winner using score-proportional (roulette wheel) selection:
1. Compute selection probability for each variant: p_i = score_i / sum(all_scores)
2. If all scores are 0, use uniform probability (1/${variantCount} each)
3. Generate a random number between 0 and 1, then pick the variant whose cumulative probability bracket contains that number
4. Higher score = more likely to be selected, but lower scorers can still win (prevents premature convergence)`;

    case "latest":
      return `Select the variant with the most recent completion time (last to finish). If unsure, pick the highest variant index.`;
  }
}
