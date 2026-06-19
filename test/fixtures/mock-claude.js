#!/usr/bin/env node
// Mock Claude binary for integration tests.
// Accepts any CLI flags, ignores them.
// Env vars:
//   MOCK_CLAUDE_RESULT      - result text (default: "mock result")
//   MOCK_CLAUDE_EXIT_CODE   - exit code (default: 0)
//   MOCK_CLAUDE_DELAY_MS    - delay before output (default: 100)

const result = process.env.MOCK_CLAUDE_RESULT ?? "mock result";
const exitCode = parseInt(process.env.MOCK_CLAUDE_EXIT_CODE ?? "0", 10);
const delayMs = parseInt(process.env.MOCK_CLAUDE_DELAY_MS ?? "100", 10);

setTimeout(() => {
  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: result }],
      },
    }) + "\n"
  );
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result,
    }) + "\n"
  );
  process.exit(exitCode);
}, delayMs);
