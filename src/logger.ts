import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const logDir = join(homedir(), '.cc-agent', 'logs');
const logFile = join(logDir, 'cc-agent.log');

const MAX_LOG_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_LOG_FILES = 5;

function ensureLogDir() {
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
}

export function rotateLog(): void {
  try {
    if (!existsSync(logFile)) return;
    const { size } = statSync(logFile);
    if (size < MAX_LOG_SIZE) return;

    // Remove oldest rotated file if it exists
    const oldest = `${logFile}.${MAX_LOG_FILES}`;
    if (existsSync(oldest)) unlinkSync(oldest);

    // Shift rotated files: .4 -> .5, .3 -> .4, ..., .1 -> .2
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const src = `${logFile}.${i}`;
      if (existsSync(src)) renameSync(src, `${logFile}.${i + 1}`);
    }

    // Rotate current log: cc-agent.log -> cc-agent.log.1
    renameSync(logFile, `${logFile}.1`);
  } catch {}
}

function fmt(level: string, msg: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const extra = data !== undefined ? ' ' + JSON.stringify(data) : '';
  return `${ts} [${level}] ${msg}${extra}\n`;
}

function writeLog(line: string): void {
  ensureLogDir();
  rotateLog();
  appendFileSync(logFile, line);
}

export const logger = {
  info: (msg: string, data?: unknown) => {
    const line = fmt('INFO', msg, data);
    process.stderr.write(line);
    try { writeLog(line); } catch {}
  },
  warn: (msg: string, data?: unknown) => {
    const line = fmt('WARN', msg, data);
    process.stderr.write(line);
    try { writeLog(line); } catch {}
  },
  error: (msg: string, err?: unknown) => {
    const data = err instanceof Error ? { message: err.message, stack: err.stack } : err;
    const line = fmt('ERROR', msg, data);
    process.stderr.write(line);
    try { writeLog(line); } catch {}
  },
};
