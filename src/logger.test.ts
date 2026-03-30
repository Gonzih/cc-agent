import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => {
  const store: Record<string, number> = {};
  return {
    existsSync: vi.fn((p: string) => p in store),
    statSync: vi.fn((p: string) => ({ size: store[p] ?? 0 })),
    renameSync: vi.fn((src: string, dst: string) => {
      store[dst] = store[src];
      delete store[src];
    }),
    unlinkSync: vi.fn((p: string) => { delete store[p]; }),
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    // expose store for test setup
    __store: store,
  };
});

const fs = await import('fs');
const store = (fs as unknown as { __store: Record<string, number> }).__store;

function setFileSize(path: string, size: number) {
  store[path] = size;
}
function fileExists(path: string) {
  return path in store;
}

import { join } from 'path';
import { homedir } from 'os';

const logDir = join(homedir(), '.cc-agent', 'logs');
const logFile = join(logDir, 'cc-agent.log');

describe('rotateLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(store)) delete store[k];
  });

  it('does nothing when log file does not exist', async () => {
    const { rotateLog } = await import('./logger.js');
    rotateLog();
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it('does nothing when file is under 50MB', async () => {
    setFileSize(logFile, 10 * 1024 * 1024); // 10MB
    const { rotateLog } = await import('./logger.js');
    rotateLog();
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it('rotates when file reaches 50MB', async () => {
    setFileSize(logFile, 50 * 1024 * 1024); // exactly 50MB
    const { rotateLog } = await import('./logger.js');
    rotateLog();
    expect(fs.renameSync).toHaveBeenCalledWith(logFile, `${logFile}.1`);
  });

  it('shifts existing rotated files before rotating', async () => {
    setFileSize(logFile, 60 * 1024 * 1024);
    setFileSize(`${logFile}.1`, 1);
    setFileSize(`${logFile}.2`, 1);
    const { rotateLog } = await import('./logger.js');
    rotateLog();
    // .2 -> .3, .1 -> .2, then .log -> .1
    const calls = (fs.renameSync as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toEqual([
      [`${logFile}.2`, `${logFile}.3`],
      [`${logFile}.1`, `${logFile}.2`],
      [logFile, `${logFile}.1`],
    ]);
  });

  it('deletes the oldest file (.5) before rotating when it exists', async () => {
    setFileSize(logFile, 60 * 1024 * 1024);
    for (let i = 1; i <= 5; i++) setFileSize(`${logFile}.${i}`, 1);
    const { rotateLog } = await import('./logger.js');
    rotateLog();
    expect(fs.unlinkSync).toHaveBeenCalledWith(`${logFile}.5`);
  });
});
