// src/content/logger.ts
// Tiny leveled logger with an in-memory ring buffer that survives reloads via
// localStorage. warn/error entries are persisted immediately; everything is
// filtered by the LOG_LEVEL from config.ts.

import { LOG_LEVEL, LOG_BUFFER_SIZE, LS_LOG_KEY, PREFIX, type LogLevel } from '../config.ts';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Last payload written to localStorage; used to skip redundant writes. */
let lastPersistedPayload: string | null = null;

let ring: LogEntry[] = [];

function isEnabled(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[LOG_LEVEL];
}

function formatData(data: unknown[]): string {
  return data
    .map((d) => {
      if (d instanceof Error) return d.message || d.name;
      if (typeof d === 'string') return d;
      try {
        return JSON.stringify(d);
      } catch {
        return String(d);
      }
    })
    .join(' ');
}

function consoleFnFor(level: LogLevel): (...args: unknown[]) => void {
  switch (level) {
    case 'debug':
      return console.debug.bind(console);
    case 'info':
      return console.info.bind(console);
    case 'warn':
      return console.warn.bind(console);
    default:
      return console.error.bind(console);
  }
}

export function log(level: LogLevel, message: string, ...data: unknown[]): void {
  if (!isEnabled(level)) return;

  const entry: LogEntry = {
    ts: Date.now(),
    level,
    msg: data.length ? `${message} ${formatData(data)}` : message
  };
  ring.push(entry);
  if (ring.length > LOG_BUFFER_SIZE) {
    ring.splice(0, ring.length - LOG_BUFFER_SIZE);
  }

  const fn = consoleFnFor(level);
  if (data.length) {
    fn(`${PREFIX}[${level}] ${message}`, ...data);
  } else {
    fn(`${PREFIX}[${level}] ${message}`);
  }

  if (level === 'warn' || level === 'error') persist();
}

export const logger = {
  debug: (message: string, ...data: unknown[]) => log('debug', message, ...data),
  info: (message: string, ...data: unknown[]) => log('info', message, ...data),
  warn: (message: string, ...data: unknown[]) => log('warn', message, ...data),
  error: (message: string, ...data: unknown[]) => log('error', message, ...data)
};

/** Snapshot of the current ring buffer (newest entries last). */
export function getLogs(): LogEntry[] {
  return ring.slice();
}

/** Clear the in-memory ring buffer and any persisted log snapshot. */
export function clearLogs(): void {
  ring = [];
  lastPersistedPayload = null;
  try {
    localStorage.removeItem(LS_LOG_KEY);
  } catch {
    // ignore
  }
}

/**
 * Restore the persisted ring.
 *
 * Anything that is not a well-formed LogEntry is dropped, and the result is
 * capped at LOG_BUFFER_SIZE: an unbounded or hand-edited payload used to be
 * adopted verbatim, so a corrupt value could grow the ring past its cap and
 * every subsequent persist would re-serialize it.
 */
export function loadLogs(): void {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(LS_LOG_KEY);
    if (!raw) return;
    parsed = JSON.parse(raw);
  } catch {
    // Malformed persisted logs are simply discarded.
    return;
  }
  if (!Array.isArray(parsed)) return;
  const valid = parsed.filter(isLogEntry);
  ring = valid.slice(-LOG_BUFFER_SIZE);
}

function isLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<LogEntry>;
  return (
    typeof entry.ts === 'number' &&
    typeof entry.msg === 'string' &&
    typeof entry.level === 'string' &&
    entry.level in LEVEL_RANK
  );
}

/**
 * Write the ring to localStorage, skipping redundant writes.
 *
 * Every warn/error used to re-serialize the whole ring and hit localStorage
 * even when nothing had changed since the last write. Comparing against the
 * last written payload makes repeats free while keeping the persisted log
 * immediately readable (no timer, no lost entries on unload).
 */
function persist(): void {
  const payload = JSON.stringify(ring);
  if (payload === lastPersistedPayload) return;
  try {
    localStorage.setItem(LS_LOG_KEY, payload);
    lastPersistedPayload = payload;
  } catch {
    // localStorage may be unavailable or full; the ring buffer still holds logs.
  }
}

loadLogs();
