# Plan: Update cc-wire to 0.1.6, use NotificationPayload type

## Task restated
Update `@gonzih/cc-wire` to 0.1.6 and replace any ad-hoc notification payload
construction with the `NotificationPayload` type from cc-wire. Ensure all
channel/key construction uses cc-wire builders (no hardcoded `cca:notify:*`
strings in production code).

## Findings
- `package.json` already bumped to `^0.1.6` by `npm install`
- `coordinator.ts::notify()` builds `JSON.stringify({ text })` without typing —
  fix: `const payload: NotificationPayload = { text }; JSON.stringify(payload)`
- All key/channel builders (`notifyChannel`, `notifyLogKey`) already imported
  from cc-wire in production code — no hardcoded strings to replace
- Test file has hardcoded `"cca:notify:test-ns"` but those are correct
  assertions (they verify the channel name resolves correctly) — no change needed
- `notifyPublishCommand` and `Transport` type are exported by 0.1.6 but have no
  current call sites in cc-agent — no forced usage needed

## Files to touch
- `src/coordinator.ts` — add `NotificationPayload` import; type the payload

## Approach
Minimal: one import addition + one type annotation. Everything else already uses
cc-wire builders correctly.
