# Plan: Multi-Agent Driver Abstraction

## Task Restatement
Add a driver abstraction layer so cc-agent can run any coding agent (Claude Code, aider, or
any OpenAI-API-compatible model) instead of being hardcoded to Claude Code. The MCP interface,
Redis schema, and existing agent behaviour must remain backward-compatible.

## Approach
Single-branch refactor with a new `src/drivers/` directory. Strategy:
- `ClaudeCodeDriver` wraps existing `runClaude()` from `claude.ts` — zero behaviour change
- `AiderDriver` spawns the `aider` CLI
- `OpenAICompatibleDriver` runs an embedded agentic loop (fetch → tool exec → loop)
- `agent.ts` calls `getDriver(job.agentDriver ?? 'claude').spawn()` instead of `runClaude()` directly
- New params `agent_driver`, `agent_model`, `openai_base_url`, `openai_api_key` added to `spawn_agent` MCP tool
- All new params are optional with safe defaults

## Files to Touch
- NEW: `src/drivers/types.ts` — AgentDriver interface + AgentProcess + SpawnOptions
- NEW: `src/drivers/pricing.ts` — model pricing registry
- NEW: `src/drivers/claude-code.ts` — ClaudeCodeDriver
- NEW: `src/drivers/aider.ts` — AiderDriver
- NEW: `src/drivers/openai-compatible.ts` — OpenAICompatibleDriver with embedded loop
- NEW: `src/drivers/index.ts` — registry (getDriver / listDrivers)
- NEW: `src/drivers/__tests__/pricing.test.ts`
- NEW: `src/drivers/__tests__/claude-code.test.ts`
- NEW: `src/drivers/__tests__/openai-compatible.test.ts`
- MOD: `src/types.ts` — add agentDriver/agentModel to Job + SpawnOptions
- MOD: `src/store.ts` — add agentDriver/agentModel to JobRecord
- MOD: `src/agent.ts` — use driver abstraction; update toRecord/fromRecord/calculateCost
- MOD: `src/index.ts` — new MCP params + list_drivers tool

## Risks
- Breaking existing ClaudeCode behavior: mitigated by ClaudeCodeDriver wrapping runClaude() exactly
- OpenAI loop executing unsafe tool output: mitigated by 30s timeout + truncation + no eval
- Ollama support (ollamaModel/ollamaHost) needs to flow through env dict to ClaudeCodeDriver
- TypeScript ESM: all imports must use .js extension
