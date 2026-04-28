/**
 * logger.ts — Centralized logger for Synapseia Node
 *
 * Format: HH:MM:SS.mmm  LEVEL  message
 * Colors: timestamp=gray, DEBUG=cyan, INFO=green, WARN=yellow, ERROR=red
 * No service prefix — the message itself should be self-descriptive.
 *
 * Tap: callers can subscribe to warn/error/info/debug emissions via
 *   setLoggerTap(fn)
 * The TelemetryClient registers itself here at boot so every
 * `logger.error(...)` automatically becomes a `subsystem.error` event.
 * The tap NEVER sees raw process state — it gets the same string args
 * the console saw, post-formatting in the caller's hands.
 */

// ANSI color codes
const C = {
  reset:  '\x1b[0m',
  gray:   '\x1b[90m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  bold:   '\x1b[1m',
};

function timestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${C.gray}${hh}:${mm}:${ss}.${ms}${C.reset}`;
}

function stripServicePrefix(msg: string): string {
  // Remove [ServiceName] prefix like [WorkOrderAgent], [Heartbeat], etc.
  return msg.replace(/^\[[^\]]+\]\s*/, '');
}

function format(level: string, color: string, args: unknown[]): string {
  const msg = args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a, null, 2)))
    .join(' ');
  const clean = stripServicePrefix(msg);
  return `${timestamp()}  ${color}${C.bold}${level}${C.reset}  ${clean}`;
}

/* ───────────────── Telemetry tap ───────────────── */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LoggerTap = (level: LogLevel, args: unknown[]) => void;

let activeTap: LoggerTap | null = null;

/** Register a tap. Pass `null` to clear. Last writer wins. */
export function setLoggerTap(tap: LoggerTap | null): void {
  activeTap = tap;
}

function callTap(level: LogLevel, args: unknown[]): void {
  if (!activeTap) return;
  try {
    activeTap(level, args);
  } catch {
    // Tap failures must NEVER break logging. The telemetry tap is
    // best-effort — if it throws (disk full, JSON cycle, etc.), the
    // log line still goes to the console.
  }
}

/* ───────────────── Public log API ───────────────── */

export const log = {
  debug: (...args: unknown[]) => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(format('DEBUG', C.cyan, args));
    }
    callTap('debug', args);
  },
  info: (...args: unknown[]) => {
    console.log(format('INFO ', C.green, args));
    callTap('info', args);
  },
  warn: (...args: unknown[]) => {
    console.warn(format('WARN ', C.yellow, args));
    callTap('warn', args);
  },
  error: (...args: unknown[]) => {
    console.error(format('ERROR', C.red, args));
    callTap('error', args);
  },
};

// Drop-in replacements for console.log/warn/error.
// Bound to `log` methods so they share the tap.
export const logger = {
  log:   log.info,
  info:  log.info,
  warn:  log.warn,
  error: log.error,
  debug: log.debug,
};

export default logger;
