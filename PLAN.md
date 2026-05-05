# Plan: Add Gemini CLI, Amp, and Codex CLI Drivers

## Task Restatement
Add three new AgentDriver implementations to cc-agent:
1. **Gemini CLI** (`gemini` driver) — Google's Gemini CLI, NDJSON stream-json output, GEMINI_API_KEY
2. **Amp** (`amp` driver) — Sourcegraph Amp, Claude Code-compatible stream-json output, AMP_API_KEY
3. **Codex CLI** (`codex` driver) — OpenAI Codex CLI, plain text output, OPENAI_API_KEY

Each driver follows the existing AgentDriver interface in src/drivers/types.ts.

## Approaches Considered

**Option A — New files per driver (chosen)**
- Create `src/drivers/gemini.ts`, `src/drivers/amp.ts`, `src/drivers/codex.ts`
- Each is a self-contained class implementing AgentDriver
- Clean separation; follows existing pattern (aider.ts, claude-code.ts)

**Option B — Extend OpenAICompatibleDriver for Codex**
- Codex is an OpenAI CLI tool; could piggyback on openai-compatible
- But Codex is a subprocess (not API), output is plain text — incompatible pattern

**Option C — Single CLIDriver base class**
- Extract shared subprocess logic into a base class
- Overkill for 3 drivers; existing code doesn't use this pattern

Going with Option A — matches codebase conventions exactly.

## Files to Touch
- NEW: `src/drivers/gemini.ts` — Gemini CLI driver
- NEW: `src/drivers/amp.ts` — Amp driver (reuses Claude Code stream-json parsing)
- NEW: `src/drivers/codex.ts` — Codex CLI plain-text driver
- MOD: `src/drivers/pricing.ts` — add Gemini, Amp, OpenAI Codex models
- MOD: `src/drivers/index.ts` — register new drivers in VALID_DRIVERS, getDriver, getDriverStatus
- MOD: `src/index.ts` — update agent_driver param description

## Key Decisions
- **Gemini stream-json**: parse NDJSON looking for `type`, `content`, `text`, `usageMetadata` fields; best-effort since schema not fully documented
- **Amp stream-json**: reuse same NDJSON parsing logic as claude.ts (message_start, message_delta, result, tool_use, etc.) — documented as Claude Code-compatible
- **Codex plain text**: each stdout line → "text" event; no structured usage
- **Binary resolution**: follow aider.ts PATH-walk + fallbacks pattern
- **Env/token**: each driver passes its API key env var, falls back to options.token

## Risks
- Gemini CLI stream-json schema is undocumented; parser may need updating when real output is observed
- Amp docs say "Claude Code compatible" but exact compatibility level unknown
- Codex CLI binary name may vary by install method (npm vs rust binary)
