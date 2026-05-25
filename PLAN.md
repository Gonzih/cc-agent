# Plan: Comprehensive Test Coverage Report

## Task Restatement
Scan the entire codebase and generate a comprehensive coverage report identifying all files,
modules, functions, and branches lacking test coverage. Document findings in a structured
format (JSON + CSV) with coverage percentages per file.

## Approaches

### Option A: Run vitest --coverage and parse the JSON output
- Pro: exact numbers from the actual coverage tool (v8); includes per-function/branch data
- Con: requires npm install first; slow if test suite is large
- **Chosen** — ground-truth data beats any manual analysis

### Option B: Static analysis only (grep for untested functions)
- Pro: fast, no runtime
- Con: imprecise; misses branch-level coverage; false positives

### Option C: Combine A + B
- Pro: richer report
- Con: extra complexity; the v8 JSON report already has everything needed

## Approach
1. `npm install` to get vitest + coverage-v8
2. `npm run test:coverage -- --reporter=verbose --coverage.reporter=json` to emit coverage/coverage-final.json
3. Parse coverage-final.json → generate coverage-report.json (per-file summary) and coverage-report.csv
4. Commit the reports to the branch and open a PR

## Files to Touch
- `coverage-report.json` (new — generated artifact)
- `coverage-report.csv` (new — generated artifact)
- `PLAN.md`, `TODO.md` (this session)

## Risks
- npm install may take time
- Some source files may be excluded from coverage by tsconfig/vitest config
- Test failures may prevent coverage from being generated (existing 12 failures are known)
