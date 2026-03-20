import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ensureStateDirs,
  loadPersistedJobs,
  savePersistedJobs,
  appendLog,
  readLogSync,
  isPidAlive,
  STATE_DIR,
  JOBS_FILE,
  LOGS_DIR,
} from "./state.js";

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "fs";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("ensureStateDirs", () => {
  it("creates state and logs directories", () => {
    ensureStateDirs();
    expect(mkdirSync).toHaveBeenCalledWith(STATE_DIR, { recursive: true });
    expect(mkdirSync).toHaveBeenCalledWith(LOGS_DIR, { recursive: true });
  });
});

describe("loadPersistedJobs", () => {
  it("returns [] when file does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(loadPersistedJobs()).toEqual([]);
  });

  it("parses valid JSON", () => {
    const jobs = [
      {
        id: "1",
        status: "done",
        repoUrl: "https://github.com/test/repo",
        task: "do something",
        startedAt: new Date().toISOString(),
      },
    ];
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(jobs) as any);
    expect(loadPersistedJobs()).toEqual(jobs);
  });

  it("returns [] on corrupt JSON", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not valid json" as any);
    expect(loadPersistedJobs()).toEqual([]);
  });
});

describe("savePersistedJobs", () => {
  it("writes jobs to file", () => {
    const jobs = [
      {
        id: "abc",
        status: "done" as const,
        repoUrl: "https://github.com/test/repo",
        task: "t",
        startedAt: "2024-01-01T00:00:00.000Z",
      },
    ];
    savePersistedJobs(jobs);
    expect(writeFileSync).toHaveBeenCalledWith(
      JOBS_FILE,
      JSON.stringify(jobs, null, 2),
      "utf-8"
    );
  });

  it("is readable back via loadPersistedJobs", () => {
    const jobs = [
      {
        id: "abc",
        status: "done" as const,
        repoUrl: "https://github.com/test/repo",
        task: "t",
        startedAt: "2024-01-01T00:00:00.000Z",
      },
    ];
    let stored = "";
    vi.mocked(writeFileSync).mockImplementation((_p, data) => {
      stored = data as string;
    });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => stored as any);

    savePersistedJobs(jobs);
    expect(loadPersistedJobs()).toEqual(jobs);
  });
});

describe("appendLog", () => {
  it("appends a line with newline to the log file", () => {
    appendLog("job-123", "hello world");
    expect(appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining("job-123.log"),
      "hello world\n",
      "utf-8"
    );
  });
});

describe("readLogSync", () => {
  it("returns [] when file does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(readLogSync("job-404", 0)).toEqual([]);
  });

  it("reads all lines with offset 0", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("line1\nline2\nline3\n" as any);
    expect(readLogSync("job-1", 0)).toEqual(["line1", "line2", "line3"]);
  });

  it("reads lines starting from offset", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("line1\nline2\nline3\n" as any);
    expect(readLogSync("job-1", 1)).toEqual(["line2", "line3"]);
  });
});

describe("isPidAlive", () => {
  it("returns true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for an invalid PID", () => {
    expect(isPidAlive(999999999)).toBe(false);
  });
});
