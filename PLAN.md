# Plan: Built-in Job Profiles

## Task Restatement
Add 7 pre-seeded profile templates that are auto-created on startup if they don't already exist.
Users start with useful defaults (fix-issue, implement-feature, write-tests, security-audit, refactor, review-pr, bump-deps).
Seeding is idempotent — existing custom profiles with the same name are never overwritten.
`list_profiles` shows a `[builtin]` tag for built-in profiles.

## Approach

**Option A — Seed at startup (chosen)**
- Create `src/seeds.ts` with `BUILTIN_PROFILES` constant and `seedBuiltinProfiles(profileStore)`
- Call it in `src/index.ts` startup block (after `initRedis`, before server.connect)
- Add `builtin?: boolean` to `Profile` interface
- Idempotency: `getProfile(name)` check before each `saveProfile` — only create if null
- `list_profiles` output already maps profile fields; add `builtin` to the mapped shape

**Option B — Separate `seed_profiles` MCP command**
- User must call it explicitly — bad UX, violates spec requirement ("auto-seed on first run")

**Option C — Bake profiles into the disk file at install time**
- Won't work for Redis-backed installs; harder to version

Going with Option A.

## Files to Touch
- MOD: `src/store.ts` — add `builtin?: boolean` to `Profile`
- NEW: `src/seeds.ts` — `BUILTIN_PROFILES` + `seedBuiltinProfiles()`
- MOD: `src/index.ts` — call `seedBuiltinProfiles(profileStore)` at startup; update `list_profiles`
- NEW: `src/seeds.test.ts` — tests for seeding
- MOD: `PLAN.md`, `TODO.md`

## Risks
- Redis-backed installs: `getProfile` hits Redis, so idempotency check works correctly
- Disk-backed installs: `getProfile` reads profiles.json, same check applies
- `builtin: true` stored in JSON — survives Redis TTL-less storage (profiles have no TTL)
- Tests: seeds.test.ts can use in-memory ProfileStore directly (no Redis mock needed)
