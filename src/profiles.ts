import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const STATE_DIR = join(homedir(), ".cc-agent");
const PROFILES_FILE = join(STATE_DIR, "profiles.json");

export interface Profile {
  name: string;
  repoUrl: string;
  taskTemplate: string; // Can contain {{variables}} for substitution
  defaultBudgetUsd?: number;
  branch?: string;
  description?: string;
  createdAt: string;
}

export function loadProfiles(): Profile[] {
  if (!existsSync(PROFILES_FILE)) return [];
  try {
    return JSON.parse(readFileSync(PROFILES_FILE, "utf-8"));
  } catch {
    return [];
  }
}

export function saveProfiles(profiles: Profile[]): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), "utf-8");
}

export function getProfile(name: string): Profile | undefined {
  return loadProfiles().find((p) => p.name === name);
}

export function upsertProfile(profile: Profile): void {
  const profiles = loadProfiles();
  const idx = profiles.findIndex((p) => p.name === profile.name);
  if (idx >= 0) profiles[idx] = profile;
  else profiles.push(profile);
  saveProfiles(profiles);
}

export function deleteProfile(name: string): boolean {
  const profiles = loadProfiles();
  const idx = profiles.findIndex((p) => p.name === name);
  if (idx < 0) return false;
  profiles.splice(idx, 1);
  saveProfiles(profiles);
  return true;
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}
