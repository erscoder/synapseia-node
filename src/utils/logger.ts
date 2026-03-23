/**
 * logger.ts — Centralized logger for Synapseia Node
 *
 * Format: HH:MM:SS.mmm  LEVEL  message
 * Colors: timestamp=gray, DEBUG=cyan, INFO=green, WARN=yellow, ERROR=red
 * No service prefix — the message itself should be self-descriptive.
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

export const log = {
  debug: (...args: unknown[]) => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(format('DEBUG', C.cyan, args));
    }
  },
  info: (...args: unknown[]) => {
    console.log(format('INFO ', C.green, args));
  },
  warn: (...args: unknown[]) => {
    console.warn(format('WARN ', C.yellow, args));
  },
  error: (...args: unknown[]) => {
    console.error(format('ERROR', C.red, args));
  },
};

// Drop-in replacements for console.log/warn/error
export const logger = {
  log:   log.info,
  info:  log.info,
  warn:  log.warn,
  error: log.error,
  debug: log.debug,
};

export default logger;
