# Plan: Add `coder` builtin profile

## Task Restatement
Add a new built-in profile named `coder` to `BUILTIN_PROFILES` in `src/seeds.ts`.
The profile carries a `preamble` containing the Karpathy coding discipline guidelines.
Also update `seedBuiltinProfiles` to overwrite existing builtin profiles (not just skip them).
Verify `spawn_from_profile` already passes `preamble` through (it does — line 1197 of index.ts).
`Profile.preamble` already exists in `src/store.ts` (line 250).

## Files to Touch
- `src/seeds.ts` — add profile, fix seeding overwrite logic
- `src/seeds.test.ts` — update count from 7→8, add overwrite test, add coder profile test

## Risks / Notes
- Test at seeds.test.ts:30 hardcodes "7 built-in profiles" — must update to 8
- Overwrite logic: only overwrite when `existing.builtin === true`; leave user-defined profiles alone
