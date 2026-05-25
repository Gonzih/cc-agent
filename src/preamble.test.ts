import { describe, it, expect, vi, afterEach } from "vitest";

// preamble.ts has no external deps — no mocking needed.
// Dynamic imports let us reset module state between fake-timer tests.

describe("getPreamble", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("returns a string containing key workflow section headers", async () => {
    const { getPreamble } = await import("./preamble.js");
    const out = getPreamble();
    expect(out).toContain("## cc-agent workflow");
    expect(out).toContain("### Planning phase");
    expect(out).toContain("### Git workflow");
    expect(out).toContain("### Rules");
  });

  it("includes the current ISO date/time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00.000Z"));
    vi.resetModules();
    const { getPreamble } = await import("./preamble.js");
    const out = getPreamble();
    expect(out).toContain("2025-06-15T12:00:00.000Z");
  });

  it("includes a human-readable date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00.000Z"));
    vi.resetModules();
    const { getPreamble } = await import("./preamble.js");
    const out = getPreamble();
    // toLocaleDateString varies by locale, but should have year and day
    expect(out).toMatch(/2025/);
  });

  it("mentions PLAN.md and TODO.md", async () => {
    const { getPreamble } = await import("./preamble.js");
    const out = getPreamble();
    expect(out).toContain("PLAN.md");
    expect(out).toContain("TODO.md");
  });

  it("mentions npm publish workflow", async () => {
    const { getPreamble } = await import("./preamble.js");
    const out = getPreamble();
    expect(out).toContain("npm publish");
  });
});

describe("BROWSER_HINT", () => {
  it("is a non-empty string mentioning Browser", async () => {
    const { BROWSER_HINT } = await import("./preamble.js");
    expect(typeof BROWSER_HINT).toBe("string");
    expect(BROWSER_HINT.length).toBeGreaterThan(0);
    expect(BROWSER_HINT).toContain("Browser");
  });

  it("contains the $B shorthand", async () => {
    const { BROWSER_HINT } = await import("./preamble.js");
    expect(BROWSER_HINT).toContain("$B");
  });
});

describe("CODE_QUALITY_CHECKLIST", () => {
  it("is a non-empty string", async () => {
    const { CODE_QUALITY_CHECKLIST } = await import("./preamble.js");
    expect(typeof CODE_QUALITY_CHECKLIST).toBe("string");
    expect(CODE_QUALITY_CHECKLIST.length).toBeGreaterThan(0);
  });

  it("contains key checklist items", async () => {
    const { CODE_QUALITY_CHECKLIST } = await import("./preamble.js");
    expect(CODE_QUALITY_CHECKLIST).toContain("git diff");
    expect(CODE_QUALITY_CHECKLIST).toContain("Tests added");
    expect(CODE_QUALITY_CHECKLIST).toContain("Build passes");
  });
});

describe("isCodeTask", () => {
  it("returns true for tasks matching code action verbs", async () => {
    const { isCodeTask } = await import("./preamble.js");
    expect(isCodeTask("build a new feature")).toBe(true);
    expect(isCodeTask("implement the login form")).toBe(true);
    expect(isCodeTask("add error handling")).toBe(true);
    expect(isCodeTask("create an endpoint")).toBe(true);
    expect(isCodeTask("fix the bug in parser.ts")).toBe(true);
  });

  it("returns false for tasks without code action verbs", async () => {
    const { isCodeTask } = await import("./preamble.js");
    expect(isCodeTask("review the pull request")).toBe(false);
    expect(isCodeTask("what is the status?")).toBe(false);
    expect(isCodeTask("explain this code")).toBe(false);
  });

  it("is case-insensitive", async () => {
    const { isCodeTask } = await import("./preamble.js");
    expect(isCodeTask("BUILD a thing")).toBe(true);
    expect(isCodeTask("Fix something")).toBe(true);
  });
});

describe("isComplexTask", () => {
  it("returns true for long tasks with complex verbs", async () => {
    const { isComplexTask } = await import("./preamble.js");
    // Must be > 100 chars and match COMPLEX_TASK_PATTERN
    const long = "refactor the entire authentication module to support OAuth2 with refresh token rotation and multi-tenant support";
    expect(long.length).toBeGreaterThan(100);
    expect(isComplexTask(long)).toBe(true);
  });

  it("returns false for short tasks even with complex verb", async () => {
    const { isComplexTask } = await import("./preamble.js");
    // Short: won't pass the length guard
    expect(isComplexTask("refactor auth")).toBe(false);
    expect(isComplexTask("migrate config")).toBe(false);
  });

  it("returns false for long tasks without complex verbs", async () => {
    const { isComplexTask } = await import("./preamble.js");
    const long = "explain the history of the project in detail, covering all the major milestones and contributors";
    expect(isComplexTask(long)).toBe(false);
  });

  it("is case-insensitive for the verb match", async () => {
    const { isComplexTask } = await import("./preamble.js");
    const long = "REFACTOR " + "the entire system to be more modular and easier to maintain in the long run".repeat(2);
    expect(isComplexTask(long)).toBe(true);
  });
});

describe("injectPreamble", () => {
  it("returns the task unchanged when noPreamble is true", async () => {
    const { injectPreamble } = await import("./preamble.js");
    const task = "do the thing";
    expect(injectPreamble(task, undefined, true)).toBe(task);
  });

  it("returns the task unchanged when noPreamble is true even with customPreamble", async () => {
    const { injectPreamble } = await import("./preamble.js");
    expect(injectPreamble("t", "custom", true)).toBe("t");
  });

  it("prepends custom preamble to the task", async () => {
    const { injectPreamble } = await import("./preamble.js");
    const result = injectPreamble("my task", "CUSTOM_PREAMBLE\n");
    expect(result).toMatch(/^CUSTOM_PREAMBLE/);
    expect(result).toContain("my task");
  });

  it("uses default preamble when no customPreamble is given", async () => {
    const { injectPreamble } = await import("./preamble.js");
    const result = injectPreamble("simple task");
    expect(result).toContain("cc-agent workflow");
    expect(result).toContain("simple task");
  });

  it("appends planning reminder for complex tasks", async () => {
    const { injectPreamble } = await import("./preamble.js");
    const complexTask =
      "refactor the entire authentication module to support OAuth2 with refresh token rotation and multi-tenant support";
    const result = injectPreamble(complexTask, "PREAMBLE\n");
    expect(result).toContain("Planning reminder");
    expect(result).toContain("PLAN.md");
  });

  it("does not append planning reminder for simple tasks", async () => {
    const { injectPreamble } = await import("./preamble.js");
    const result = injectPreamble("fix typo", "PREAMBLE\n");
    expect(result).not.toContain("Planning reminder");
  });
});

describe("getPreambleText", () => {
  it("returns empty string when noPreamble is true", async () => {
    const { getPreambleText } = await import("./preamble.js");
    expect(getPreambleText(undefined, true)).toBe("");
  });

  it("returns custom preamble string verbatim when provided", async () => {
    const { getPreambleText } = await import("./preamble.js");
    expect(getPreambleText("MY_PREAMBLE")).toBe("MY_PREAMBLE");
  });

  it("returns the default preamble when no args provided", async () => {
    const { getPreambleText } = await import("./preamble.js");
    const result = getPreambleText();
    expect(result).toContain("cc-agent workflow");
  });

  it("returns empty string when noPreamble is true even with customPreamble set", async () => {
    const { getPreambleText } = await import("./preamble.js");
    expect(getPreambleText("CUSTOM", true)).toBe("");
  });
});
