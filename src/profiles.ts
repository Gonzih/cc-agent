import { profileStore, type Profile } from "./store.js";

export type { Profile };

export async function loadProfiles(): Promise<Profile[]> {
  return profileStore.listProfiles();
}

export async function upsertProfile(profile: Profile): Promise<void> {
  return profileStore.saveProfile(profile);
}

export async function getProfile(name: string): Promise<Profile | null> {
  return profileStore.getProfile(name);
}

export async function deleteProfile(name: string): Promise<boolean> {
  return profileStore.deleteProfile(name);
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}
