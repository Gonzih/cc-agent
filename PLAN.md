# Plan: Research Inspection Tools — export_jobs, get_cost_report, search_jobs

## Task Restatement
Add three MCP tools for agentic systems researchers: JSONL/JSON trace export, longitudinal
cost reporting grouped by repo/day/status, and full-text job search by task or output content.
All tools read from the existing `jobStore` (Redis/disk) — no new dependencies.

## Approaches Considered

### A. New module src/research.ts with helpers
Extract shared logic (date filter, record mapper) into a separate file. Cleaner separation,
but the helpers are trivial (< 20 lines each) and the existing pattern is to keep everything
in index.ts handlers.

### B. Everything inline in index.ts (chosen)
Follow the exact same pattern as cost_summary, list_jobs, get_job_output. Each case does its
own `await jobStore.listJobs()`, filters, and shapes output. No new abstractions, no new deps.
Consistent with all 35+ existing tools.

### C. Streaming JSONL via separate HTTP endpoint
Overkill — MCP tools return text content blobs, not streams. Redis list is bounded (7-day TTL),
so a full dump fits in memory fine.

## Decision: Approach B
Inline handlers. Follow existing patterns exactly.

## Files to Touch
- `src/index.ts` — add 3 tool definitions + 3 case handlers
- `src/index.test.ts` — add tests for the 3 new tools

## Implementation Details

### export_jobs
- Params: `days` (default 7), `format` ("jsonl"|"json", default "jsonl"), `status` (optional)
- Logic: listJobs() → filter startedAt >= cutoff → filter status → map to lean record
- Lean record fields: id, status, repo_url, task (slice 0..500), started_at, finished_at,
  exit_code, output_lines, score, duration_seconds (computed from startedAt/finishedAt)
- Output: JSONL = one JSON object per line joined by \n; JSON = JSON.stringify(array)

### get_cost_report
- Params: `days` (default 30), `group_by` ("repo"|"day"|"status", default "repo")
- group key: "repo" → repoUrl, "day" → startedAt.slice(0,10), "status" → status
- Per group: total_usd, job_count, avg_cost_usd, avg_score (null if no scored jobs)
- Sort: by total_usd descending

### search_jobs
- Params: `query` (required), `days` (default 30), `status` (optional)
- Search in: task field (case-insensitive includes)
- Snippet: find the line containing the match, return 100 chars around it
- Output: array of { id, status, repo_url, started_at, score, task_snippet }

## Risks and Unknowns
- `listJobs()` returns ALL jobs in the namespace (no pagination in Redis SMEMBERS). For large
  namespaces this is fine — same as cost_summary which already does this.
- `startedAt` may be undefined for jobs that never started (pending). Filter those out for
  date-based filtering (treat as outside the window).
- `format` validation: invalid value → default to "jsonl" gracefully.
