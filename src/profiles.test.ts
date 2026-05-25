import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted to the top of the file, so variables used inside the
// factory must be created with vi.hoisted() to be available at hoist time.
const mockProfileStore = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  saveProfile: vi.fn(),
  getProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));

vi.mock("./store.js", () => ({
  profileStore: mockProfileStore,
}));

import { interpolate, loadProfiles, upsertProfile, getProfile, deleteProfile } from "./profiles.js";
import type { Profile } from "./profiles.js";

// ─── interpolate ─────────────────────────────────────────────────────────────

describe("interpolate", () => {
  it("replaces a single placeholder", () => {
    expect(interpolate("Hello {{name}}!", { name: "world" })).toBe("Hello world!");
  });

  it("replaces multiple different placeholders", () => {
    expect(
      interpolate("{{greeting}}, {{name}}. Repo: {{repo}}", {
        greeting: "Hi",
        name: "Alice",
        repo: "my/repo",
      })
    ).toBe("Hi, Alice. Repo: my/repo");
  });

  it("replaces repeated placeholders", () => {
    expect(interpolate("{{x}} and {{x}}", { x: "foo" })).toBe("foo and foo");
  });

  it("leaves unknown placeholders intact with their original syntax", () => {
    expect(interpolate("Hello {{unknown}}", {})).toBe("Hello {{unknown}}");
  });

  it("returns template unchanged when there are no placeholders", () => {
    expect(interpolate("No placeholders here.", { x: "y" })).toBe("No placeholders here.");
  });

  it("handles empty template", () => {
    expect(interpolate("", { key: "val" })).toBe("");
  });

  it("handles template with only a placeholder", () => {
    expect(interpolate("{{val}}", { val: "42" })).toBe("42");
  });

  it("does not replace partial syntax — single braces are left alone", () => {
    expect(interpolate("{name}", { name: "x" })).toBe("{name}");
  });

  it("handles vars with special regex characters in values", () => {
    expect(interpolate("{{url}}", { url: "https://example.com/path?q=1&r=2" })).toBe(
      "https://example.com/path?q=1&r=2"
    );
  });

  it("handles multi-line templates", () => {
    const template = "Line 1: {{a}}\nLine 2: {{b}}";
    expect(interpolate(template, { a: "hello", b: "world" })).toBe(
      "Line 1: hello\nLine 2: world"
    );
  });
});

// ─── profileStore delegate wrappers ──────────────────────────────────────────

const sampleProfile: Profile = {
  name: "my-profile",
  task: "Do {{thing}} in {{repo}}",
};

describe("loadProfiles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates to profileStore.listProfiles", async () => {
    mockProfileStore.listProfiles.mockResolvedValue([sampleProfile]);
    const result = await loadProfiles();
    expect(mockProfileStore.listProfiles).toHaveBeenCalledOnce();
    expect(result).toEqual([sampleProfile]);
  });

  it("returns empty array when store has no profiles", async () => {
    mockProfileStore.listProfiles.mockResolvedValue([]);
    expect(await loadProfiles()).toEqual([]);
  });
});

describe("upsertProfile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates to profileStore.saveProfile with the profile", async () => {
    mockProfileStore.saveProfile.mockResolvedValue(undefined);
    await upsertProfile(sampleProfile);
    expect(mockProfileStore.saveProfile).toHaveBeenCalledWith(sampleProfile);
  });
});

describe("getProfile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates to profileStore.getProfile with the name", async () => {
    mockProfileStore.getProfile.mockResolvedValue(sampleProfile);
    const result = await getProfile("my-profile");
    expect(mockProfileStore.getProfile).toHaveBeenCalledWith("my-profile");
    expect(result).toEqual(sampleProfile);
  });

  it("returns null when profile does not exist", async () => {
    mockProfileStore.getProfile.mockResolvedValue(null);
    expect(await getProfile("nonexistent")).toBeNull();
import { describe, it, expect, afterEach } from "vitest";
import { interpolate, loadProfiles, upsertProfile, getProfile, deleteProfile } from "./profiles.js";
import type { Profile } from "./profiles.js";

// Restore namespace after each test to avoid cross-test pollution
afterEach(() => {
  delete process.env.CC_AGENT_NAMESPACE;
});

// ─── interpolate() ────────────────────────────────────────────────────────────

describe("interpolate", () => {
  it("replaces a single {{var}} with its value", () => {
    expect(interpolate("Hello {{name}}", { name: "World" })).toBe("Hello World");
  });

  it("replaces multiple distinct variables", () => {
    const result = interpolate("{{greeting}} {{name}}!", { greeting: "Hi", name: "Alice" });
    expect(result).toBe("Hi Alice!");
  });

  it("replaces the same variable appearing multiple times", () => {
    expect(interpolate("{{x}} and {{x}} again", { x: "42" })).toBe("42 and 42 again");
  });

  it("leaves unmatched variables intact as {{key}}", () => {
    expect(interpolate("Hello {{missing}}", {})).toBe("Hello {{missing}}");
  });

  it("leaves partially-matched template intact for missing keys", () => {
    const result = interpolate("{{known}} {{unknown}}", { known: "hello" });
    expect(result).toBe("hello {{unknown}}");
  });

  it("returns the template unchanged when it has no variables", () => {
    const tpl = "No variables here";
    expect(interpolate(tpl, {})).toBe(tpl);
  });

  it("returns the template unchanged when vars is empty", () => {
    const tpl = "{{a}} and {{b}}";
    expect(interpolate(tpl, {})).toBe("{{a}} and {{b}}");
  });

  it("only replaces \\w+ (word char) patterns between braces", () => {
    // Spaces inside braces should NOT be replaced
    const tpl = "{{valid}} {{ not_replaced }}";
    expect(interpolate(tpl, { valid: "ok", " not_replaced ": "x" })).toBe("ok {{ not_replaced }}");
  });

  it("handles empty string template", () => {
    expect(interpolate("", { x: "val" })).toBe("");
  });

  it("handles empty string variable value", () => {
    expect(interpolate("prefix{{x}}suffix", { x: "" })).toBe("prefixsuffix");
  });

  it("handles numeric-looking values", () => {
    expect(interpolate("Budget: ${{amount}}", { amount: "100" })).toBe("Budget: $100");
  });
});

// ─── ProfileStore delegation via profiles.ts ──────────────────────────────────

function makeProfile(name: string, extra: Partial<Profile> = {}): Profile {
  return {
    name,
    repoUrl: "https://github.com/test/repo.git",
    taskTemplate: "Run {{action}} on {{target}}",
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

describe("getProfile", () => {
  it("returns null for a name that has never been saved", async () => {
    const found = await getProfile("nonexistent-profile-xyz-abc");
    expect(found).toBeNull();
  });

  it("returns the profile after upsertProfile", async () => {
    await upsertProfile(makeProfile("roundtrip-test"));
    const found = await getProfile("roundtrip-test");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("roundtrip-test");
  });

  it("returns the correct repoUrl", async () => {
    await upsertProfile(makeProfile("repo-check", { repoUrl: "https://github.com/acme/widget.git" }));
    const found = await getProfile("repo-check");
    expect(found?.repoUrl).toBe("https://github.com/acme/widget.git");
  });

  it("returns updated profile after second upsert with same name", async () => {
    await upsertProfile(makeProfile("upsert-overwrite", { taskTemplate: "first" }));
    await upsertProfile(makeProfile("upsert-overwrite", { taskTemplate: "second" }));
    const found = await getProfile("upsert-overwrite");
    expect(found?.taskTemplate).toBe("second");
  });
});

describe("loadProfiles", () => {
  it("returns an array", async () => {
    const profiles = await loadProfiles();
    expect(Array.isArray(profiles)).toBe(true);
  });

  it("includes a profile after it is upserted", async () => {
    await upsertProfile(makeProfile("load-test-profile"));
    const profiles = await loadProfiles();
    const names = profiles.map((p) => p.name);
    expect(names).toContain("load-test-profile");
  });

  it("does not include profiles that were deleted", async () => {
    await upsertProfile(makeProfile("temp-for-load-test"));
    await deleteProfile("temp-for-load-test");
    const profiles = await loadProfiles();
    expect(profiles.some((p) => p.name === "temp-for-load-test")).toBe(false);
  });
});

describe("deleteProfile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates to profileStore.deleteProfile and returns true on success", async () => {
    mockProfileStore.deleteProfile.mockResolvedValue(true);
    const result = await deleteProfile("my-profile");
    expect(mockProfileStore.deleteProfile).toHaveBeenCalledWith("my-profile");
    expect(result).toBe(true);
  });

  it("returns false when the profile did not exist", async () => {
    mockProfileStore.deleteProfile.mockResolvedValue(false);
    expect(await deleteProfile("missing")).toBe(false);
  it("returns false for a profile that never existed", async () => {
    const deleted = await deleteProfile("no-such-profile-xyz");
    expect(deleted).toBe(false);
  });

  it("returns true after deleting an existing profile", async () => {
    await upsertProfile(makeProfile("to-delete-profile"));
    const deleted = await deleteProfile("to-delete-profile");
    expect(deleted).toBe(true);
  });

  it("makes the profile invisible to getProfile after deletion", async () => {
    await upsertProfile(makeProfile("gone-profile"));
    await deleteProfile("gone-profile");
    const found = await getProfile("gone-profile");
    expect(found).toBeNull();
  });

  it("returns false on a second delete of the same profile", async () => {
    await upsertProfile(makeProfile("once-profile"));
    await deleteProfile("once-profile");
    const secondDelete = await deleteProfile("once-profile");
    expect(secondDelete).toBe(false);
  });
});

// ─── interpolate + profile template integration ───────────────────────────────

describe("interpolate used with profile.taskTemplate", () => {
  it("renders a stored profile's taskTemplate with provided vars", async () => {
    await upsertProfile(makeProfile("template-user", {
      taskTemplate: "Deploy {{service}} to {{env}}",
    }));
    const profile = await getProfile("template-user");
    expect(profile).not.toBeNull();
    const rendered = interpolate(profile!.taskTemplate, { service: "api", env: "staging" });
    expect(rendered).toBe("Deploy api to staging");
  });

  it("leaves missing template vars as-is when vars are absent", async () => {
    await upsertProfile(makeProfile("partial-vars", {
      taskTemplate: "Run {{action}} on {{target}}",
    }));
    const profile = await getProfile("partial-vars");
    const rendered = interpolate(profile!.taskTemplate, { action: "test" });
    // {{target}} has no var → stays as-is
    expect(rendered).toBe("Run test on {{target}}");
  });
});
