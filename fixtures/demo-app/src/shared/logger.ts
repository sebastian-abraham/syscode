import { config } from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = RANK[config.logLevel];

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (RANK[level] < min) return;
  const line = { ts: new Date().toISOString(), level, msg, ...extra };
  const sink = level === 'error' ? process.stderr : process.stdout;
  sink.write(JSON.stringify(line) + '\n');
}

export const logger = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
};
