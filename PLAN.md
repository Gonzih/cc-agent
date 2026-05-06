# Plan: Add AMAI brand icon

## Task Restatement
Add the AMAI money-brain logo PNG to the repo under `assets/logo.png` and display it at the top of README.md using an HTML `<img>` tag.

## Approach
Single straightforward task — no alternatives needed.

1. Create `assets/` directory, copy image in as `logo.png`
2. Edit README.md to insert `<img src="assets/logo.png" alt="AMAI" width="120">` right after the `# cc-agent` heading
3. Commit → branch → PR → merge → publish

## Files to Touch
- `assets/logo.png` (new binary)
- `README.md` (insert img tag after first heading)
- `PLAN.md`, `TODO.md` (this run's planning files)

## Risks
- Binary file must be committed via `git add -A` to include it
- Image path in README must be relative and match the actual filename exactly
