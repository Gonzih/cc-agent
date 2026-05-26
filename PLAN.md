# Plan: Expose available profiles in MCP tool descriptions

## Task Restatement
Agents with cc-agent MCP access don't know profiles exist unless they happen to call `list_profiles`. Fix this by:
1. Updating `list_profiles` tool description to clarify it should be called before `spawn_from_profile`
2. Updating `spawn_from_profile` tool description to mention calling `list_profiles` first and listing built-in profiles
3. Adding a "Profiles" section to the preamble injected into every agent

## Files to Touch
- `src/index.ts` — update two tool descriptions (lines ~369, ~596)
- `src/preamble.ts` — add profiles section to `getPreamble()`

## Approach
Direct targeted edits to the three locations. No new abstractions needed — this is purely documentation/description text changes.

## Risks / Unknowns
- Built-in profile names must match what's actually in `src/seeds.ts` — verify before hardcoding
