import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock logger (profiles.ts doesn't use logger, but store.js transitively might)
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the profileStore from store.js so profile tests are fully isolated
const mockListProfiles = vi.fn();
const mockSaveProfile = vi.fn();
const mockGetProfile = vi.fn();
const mockDeleteProfile = vi.fn();

vi.mock("./store.js", () => ({
  profileStore: {
    listProfiles: mockListProfiles,
    saveProfile: mockSaveProfile,
    getProfile: mockGetProfile,
    deleteProfile: mockDeleteProfile,
  },
}));

describe("loadProfiles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates to profileStore.listProfiles and returns the result", async () => {
    mockListProfiles.mockResolvedValue([{ name: "a", task: "do a" }]);
    const { loadProfiles } = await import("./profiles.js");
    const result = await loadProfiles();
    expect(mockListProfiles).toHaveBeenCalledOnce();
    expect(result).toEqual([{ name: "a", task: "do a" }]);
  });

  it("returns an empty array when no profiles exist", async () => {
    mockListProfiles.mockResolvedValue([]);
    const { loadProfiles } = await import("./profiles.js");
    expect(await loadProfiles()).toEqual([]);
  });
});

describe("upsertProfile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates to profileStore.saveProfile with the given profile", async () => {
    mockSaveProfile.mockResolvedValue(undefined);
    const { upsertProfile } = await import("./profiles.js");
    await upsertProfile({ name: "my-profile", task: "run tests" });
    expect(mockSaveProfile).toHaveBeenCalledWith({ name: "my-profile", task: "run tests" });
  });
});

describe("getProfile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the profile when found", async () => {
    mockGetProfile.mockResolvedValue({ name: "foo", task: "bar" });
    const { getProfile } = await import("./profiles.js");
    const result = await getProfile("foo");
    expect(mockGetProfile).toHaveBeenCalledWith("foo");
    expect(result).toEqual({ name: "foo", task: "bar" });
  });

  it("returns null when profile does not exist", async () => {
    mockGetProfile.mockResolvedValue(null);
    const { getProfile } = await import("./profiles.js");
    expect(await getProfile("ghost")).toBeNull();
  });
});

describe("deleteProfile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when profile was deleted", async () => {
    mockDeleteProfile.mockResolvedValue(true);
    const { deleteProfile } = await import("./profiles.js");
    const result = await deleteProfile("old");
    expect(mockDeleteProfile).toHaveBeenCalledWith("old");
    expect(result).toBe(true);
  });

  it("returns false when profile was not found", async () => {
    mockDeleteProfile.mockResolvedValue(false);
    const { deleteProfile } = await import("./profiles.js");
    expect(await deleteProfile("missing")).toBe(false);
  });
});

describe("interpolate", () => {
  it("replaces a single {{key}} placeholder", async () => {
    const { interpolate } = await import("./profiles.js");
    expect(interpolate("Hello {{name}}!", { name: "world" })).toBe("Hello world!");
  });

  it("replaces multiple distinct placeholders", async () => {
    const { interpolate } = await import("./profiles.js");
    expect(interpolate("{{greeting}}, {{name}}.", { greeting: "Hi", name: "Alice" })).toBe("Hi, Alice.");
  });

  it("replaces a placeholder that appears multiple times", async () => {
    const { interpolate } = await import("./profiles.js");
    expect(interpolate("{{x}} + {{x}} = two", { x: "one" })).toBe("one + one = two");
  });

  it("leaves unknown placeholders unchanged", async () => {
    const { interpolate } = await import("./profiles.js");
    expect(interpolate("{{known}} {{unknown}}", { known: "OK" })).toBe("OK {{unknown}}");
  });

  it("returns template unchanged when no placeholders are present", async () => {
    const { interpolate } = await import("./profiles.js");
    expect(interpolate("no placeholders here", { x: "y" })).toBe("no placeholders here");
  });

  it("returns empty string unchanged", async () => {
    const { interpolate } = await import("./profiles.js");
    expect(interpolate("", { x: "y" })).toBe("");
  });

  it("works with empty vars map", async () => {
    const { interpolate } = await import("./profiles.js");
    // All placeholders stay unresolved
    expect(interpolate("{{a}} {{b}}", {})).toBe("{{a}} {{b}}");
  });

  it("handles placeholder with numeric-like key name", async () => {
    const { interpolate } = await import("./profiles.js");
    // \w+ matches word chars including digits — but key must start with \w
    expect(interpolate("{{repo123}}", { repo123: "my-repo" })).toBe("my-repo");
  });
});
