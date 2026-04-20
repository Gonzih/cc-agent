import { describe, it, expect, beforeEach } from "vitest";
import type { Profile } from "./store.js";
import { seedBuiltinProfiles, BUILTIN_PROFILES } from "./seeds.js";
import type { ProfileStoreForSeeding } from "./seeds.js";

// Minimal in-memory store — avoids disk/Redis bleed from real ProfileStore
class MemoryProfileStore implements ProfileStoreForSeeding {
  private data = new Map<string, Profile>();

  async saveProfile(profile: Profile): Promise<void> {
    this.data.set(profile.name, profile);
  }

  async getProfile(name: string): Promise<Profile | null> {
    return this.data.get(name) ?? null;
  }

  async listProfiles(): Promise<Profile[]> {
    return Array.from(this.data.values()).sort((a, b) => a.name.localeCompare(b.name));
  }
}

describe("seedBuiltinProfiles", () => {
  let store: MemoryProfileStore;

  beforeEach(() => {
    store = new MemoryProfileStore();
  });

  it("creates all 7 built-in profiles on first seed", async () => {
    await seedBuiltinProfiles(store);
    const profiles = await store.listProfiles();
    const names = profiles.map((p) => p.name);
    expect(names).toContain("fix-issue");
    expect(names).toContain("implement-feature");
    expect(names).toContain("write-tests");
    expect(names).toContain("security-audit");
    expect(names).toContain("refactor");
    expect(names).toContain("review-pr");
    expect(names).toContain("bump-deps");
    expect(profiles.length).toBe(BUILTIN_PROFILES.length);
  });

  it("seeding is idempotent — running twice does not duplicate profiles", async () => {
    await seedBuiltinProfiles(store);
    await seedBuiltinProfiles(store);
    const profiles = await store.listProfiles();
    expect(profiles.length).toBe(BUILTIN_PROFILES.length);
  });

  it("does not overwrite a custom profile with the same name as a builtin", async () => {
    const customCreatedAt = "2020-01-01T00:00:00.000Z";
    await store.saveProfile({
      name: "fix-issue",
      repoUrl: "https://github.com/custom/repo",
      taskTemplate: "my custom template",
      createdAt: customCreatedAt,
      builtin: false,
    });

    await seedBuiltinProfiles(store);

    const profile = await store.getProfile("fix-issue");
    expect(profile).not.toBeNull();
    expect(profile!.repoUrl).toBe("https://github.com/custom/repo");
    expect(profile!.taskTemplate).toBe("my custom template");
    expect(profile!.createdAt).toBe(customCreatedAt);
  });

  it("all seeded profiles have builtin: true", async () => {
    await seedBuiltinProfiles(store);
    const profiles = await store.listProfiles();
    for (const p of profiles) {
      expect(p.builtin).toBe(true);
    }
  });

  it("seeded profiles have correct defaultBudgetUsd values", async () => {
    await seedBuiltinProfiles(store);
    const fixIssue = await store.getProfile("fix-issue");
    expect(fixIssue?.defaultBudgetUsd).toBe(15);
    const implementFeature = await store.getProfile("implement-feature");
    expect(implementFeature?.defaultBudgetUsd).toBe(20);
    const writeTests = await store.getProfile("write-tests");
    expect(writeTests?.defaultBudgetUsd).toBe(10);
    const bumpDeps = await store.getProfile("bump-deps");
    expect(bumpDeps?.defaultBudgetUsd).toBe(10);
  });

  it("list_profiles correctly marks builtins vs custom profiles", async () => {
    // Seed builtins
    await seedBuiltinProfiles(store);
    // Add a custom profile
    await store.saveProfile({
      name: "my-custom",
      repoUrl: "https://github.com/me/repo",
      taskTemplate: "do something",
      createdAt: new Date().toISOString(),
    });

    const profiles = await store.listProfiles();
    const custom = profiles.find((p) => p.name === "my-custom");
    const builtin = profiles.find((p) => p.name === "fix-issue");

    expect(custom?.builtin).toBeFalsy();
    expect(builtin?.builtin).toBe(true);
  });
});
