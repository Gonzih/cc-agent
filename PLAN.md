# Plan: Include job ID in completion notifications

## Task Restatement
Job completion/failure notifications pushed to `cca:notify:{namespace}` currently
show the title and score but not the job ID. Users can't correlate a Telegram
alert with a specific job in cc-agent-ui. Fix: embed `job_id` in the message.

## Approach
Single-line change in `coordinator.ts` `processEvent`:
Current: `${icon} ${title}${scoreStr}\n${repoUrl}`
New:     `${icon} ${title}${scoreStr} (job_id: ${jobId})\n${repoUrl}`

`jobId` is already destructured from the event on line 108.

## Files to Touch
- `src/coordinator.ts` — update notification message format (1 line)
- `src/coordinator.test.ts` — update 5 exact-string test assertions to match new format
