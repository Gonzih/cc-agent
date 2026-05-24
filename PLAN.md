# Plan: Improve job done/failed notification format

## Task Restatement
Two things are ugly in agent completion notifications sent to Telegram:
1. `title` contains raw markdown (e.g. `## Fix:`, `**word**`) because it's taken from the first line of the task prompt unmodified.
2. The notification string is dense/noisy: full UUID, full GitHub URL, everything on one line.

Desired output:
```
✅ gonzih/cc-tg · 1.00 · 381d775b
Fix cc-tg 0.9.40 published without dist/
```

## Files to touch
- `src/agent.ts` — strip markdown from title (line ~508)
- `src/coordinator.ts` — reformat notification message (line ~156)
- `src/coordinator.test.ts` — update test assertions to match new format

## Approach

### Title cleaning (agent.ts)
Extract a helper or inline logic to strip:
- Leading `#+\s*` (markdown headings)
- Surrounding `**...**` or `__...__` (bold)
- Surrounding or leading backtick phrases

Keep it simple and inline — no need for a separate utility file.

### Notification reformatting (coordinator.ts)
New format:
```
{icon} {org/repo} · {score} · {shortId}
{cleanedTitle}
```
- `org/repo`: parse last two path segments from `repoUrl` (e.g. `https://github.com/gonzih/cc-tg` → `gonzih/cc-tg`). If URL is empty/unparseable, use the full URL as fallback.
- `score`: `score.toFixed(2)` if present; omit `· {score}` segment if no score.
- `shortId`: first 8 chars of `jobId`
- `cleanedTitle`: the already-cleaned title from event (max 160 chars on line 2)

Score omission: Line 1 becomes `{icon} {org/repo} · {shortId}` when no score.

## Risks
- Tests assert the old format string — must update all matching assertions in coordinator.test.ts
- repoUrl may be empty string or undefined — guard with fallback
