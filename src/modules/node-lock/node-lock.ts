// Cross-process mutex between the CLI (`synapseia start`) and the desktop UI
// (`synapseia-node-ui`). Both launch the same node runtime; only one can own
// the network identity at a time. We serialise that via a PID lock file at
// ~/.synapseia/node.lock.
//
// The lock file is best-effort, not atomic. If the process that owns it
// crashes without cleanup, the next caller detects the stale PID and reclaims
// the lock. This is good enough for a desktop app and avoids introducing a
// native file-lock dependency.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export type NodeLockSource = 'cli' | 'ui';

export interface NodeLockInfo {
  pid: number;
  startedAt: string;
  source: NodeLockSource;
}

function lockFilePath(): string {
  const dir = process.env.SYNAPSEIA_HOME ?? join(homedir(), '.synapseia');
  return join(dir, 'node.lock');
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 = permission check only, does not actually signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but is owned by a different user —
    // treat as alive so we don't blindly reclaim someone else's lock.
    return code === 'EPERM';
  }
}

function readLockFile(): NodeLockInfo | null {
  const file = lockFilePath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    if (
      typeof parsed?.pid !== 'number' ||
      typeof parsed?.startedAt !== 'string' ||
      (parsed?.source !== 'cli' && parsed?.source !== 'ui')
    ) {
      return null;
    }
    return parsed as NodeLockInfo;
  } catch {
    return null;
  }
}

/**
 * Return the currently active lock, or null if none is held. Silently cleans
 * up stale lock files left behind by a crashed process.
 */
export function getActiveLock(): NodeLockInfo | null {
  const info = readLockFile();
  if (!info) return null;

  // If the lock PID matches ours but predates our own start, it's a stale lock
  // from a previous process instance (e.g. container restart where PID 1 is reused).
  if (info.pid === process.pid) {
    const ourStartMs = Date.now() - process.uptime() * 1000;
    const lockMs = new Date(info.startedAt).getTime();
    if (lockMs < ourStartMs - 1000) {
      try {
        unlinkSync(lockFilePath());
      } catch {
        // Already gone — fine.
      }
      return null;
    }
  }

  if (!isProcessAlive(info.pid)) {
    try {
      unlinkSync(lockFilePath());
    } catch {
      // Already gone, race with another process — fine.
    }
    return null;
  }
  return info;
}

/**
 * Try to acquire the lock for the given source. Throws with a user-facing
 * message if another node is already running. On success, writes the lock
 * file and registers cleanup handlers on the current process.
 */
export function acquireLock(source: NodeLockSource): NodeLockInfo {
  const existing = getActiveLock();
  if (existing) {
    const who =
      existing.source === 'ui' ? 'from the desktop UI' : 'from the CLI';
    throw new Error(
      `Another Synapseia node is already running ${who} (PID ${existing.pid}). ` +
        `Stop it before starting a new one.`
    );
  }

  const info: NodeLockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    source,
  };
  writeFileSync(lockFilePath(), JSON.stringify(info, null, 2), { mode: 0o600 });
  return info;
}

/**
 * Release the lock if — and only if — it still belongs to the current
 * process. A second process that reclaimed a stale lock must not be kicked
 * out by our late cleanup.
 */
export function releaseLock(): void {
  try {
    const info = readLockFile();
    if (info && info.pid === process.pid) {
      unlinkSync(lockFilePath());
    }
  } catch {
    // Best-effort cleanup.
  }
}
