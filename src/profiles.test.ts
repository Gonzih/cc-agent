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
  });
});
