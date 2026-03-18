export type JobStatus = "cloning" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  repoUrl: string;
  task: string;
  branch?: string;
  createBranch?: string;
  status: JobStatus;
  output: string[];
  exitCode?: number;
  error?: string;
  workDir?: string;
  startedAt: Date;
  finishedAt?: Date;
  pid?: number;
}

export interface SpawnOptions {
  repoUrl: string;
  task: string;
  branch?: string;
  createBranch?: string;
  claudeToken?: string;
}

export interface JobSummary {
  id: string;
  status: JobStatus;
  repoUrl: string;
  task: string;
  branch?: string;
  createBranch?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
}
