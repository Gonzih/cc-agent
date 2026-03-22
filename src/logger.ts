import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const logDir = join(homedir(), '.cc-agent', 'logs');
const logFile = join(logDir, 'cc-agent.log');

function ensureLogDir() {
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
}

function fmt(level: string, msg: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const extra = data !== undefined ? ' ' + JSON.stringify(data) : '';
  return `${ts} [${level}] ${msg}${extra}\n`;
}

export const logger = {
  info: (msg: string, data?: unknown) => {
    const line = fmt('INFO', msg, data);
    process.stderr.write(line);
    try { ensureLogDir(); appendFileSync(logFile, line); } catch {}
  },
  warn: (msg: string, data?: unknown) => {
    const line = fmt('WARN', msg, data);
    process.stderr.write(line);
    try { ensureLogDir(); appendFileSync(logFile, line); } catch {}
  },
  error: (msg: string, err?: unknown) => {
    const data = err instanceof Error ? { message: err.message, stack: err.stack } : err;
    const line = fmt('ERROR', msg, data);
    process.stderr.write(line);
    try { ensureLogDir(); appendFileSync(logFile, line); } catch {}
  },
};
