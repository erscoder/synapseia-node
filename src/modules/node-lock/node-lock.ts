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

/**
 * Public accessor for the resolved lock-file path. Honours the same
 * `SYNAPSEIA_HOME` override `acquireLock` / `getActiveLock` use, so a
 * separate process (e.g. `synapseia stop`) resolves the identical file the
 * running daemon owns.
 */
export function getLockFilePath(): string {
  return lockFilePath();
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

/** Outcome of a `stopRunningNode` invocation, mapped to an exit code by the CLI. */
export type StopOutcome =
  | 'no-lock' // No lock file → nothing to stop.
  | 'stale' // Lock present but PID dead → cleared the stale lock.
  | 'stopped' // Signalled a live daemon; it exited within the grace window.
  | 'timeout'; // Signalled a live daemon; it did NOT exit within the window.

export interface StopResult {
  outcome: StopOutcome;
  pid?: number;
  startedAt?: string;
}

/**
 * Injectable seams for `stopRunningNode`. Defaulting to the real
 * implementations keeps the production call-site a one-liner while letting
 * tests drive the SIGTERM + poll control flow deterministically (fake an
 * "alive then dead" PID, assert the signal + poll without ever touching a
 * real process or sleeping for real).
 */
export interface StopDeps {
  /** Send a signal (or probe with `0`). Mirrors `process.kill`. */
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Pause for `ms` between liveness polls. */
  sleep: (ms: number) => Promise<void>;
  /** Structured logger sink (CLI logger in prod). */
  log: (msg: string) => void;
  /** Read the current lock (defaults to the on-disk file). */
  readLock?: () => NodeLockInfo | null;
  /** Remove the lock file (defaults to unlinking the on-disk file). */
  clearLock?: () => void;
  /** Total time to wait for graceful exit after SIGTERM (default 10s). */
  graceMs?: number;
  /** Poll interval while waiting for exit (default 250ms). */
  pollMs?: number;
}

function defaultClearLock(): void {
  try {
    unlinkSync(lockFilePath());
  } catch {
    // Already gone — fine.
  }
}

/** Probe whether `pid` is alive using the injected `kill`. */
function probeAlive(kill: StopDeps['kill'], pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = exists but owned by another user → treat as alive.
    return code === 'EPERM';
  }
}

/**
 * Stop the running Synapseia daemon by signalling the PID recorded in the
 * lock file. This is the *only* correct way for an ephemeral `synapseia stop`
 * process to reach the long-lived daemon started by `synapseia start` — the
 * stop process never shares state with the daemon, so it must read the lock
 * and signal the foreign PID.
 *
 * Control flow:
 *  - No lock file        → 'no-lock'  (nothing to do).
 *  - Lock present, dead  → 'stale'    (clear the lock, no signal).
 *  - Lock present, alive → SIGTERM, then poll up to `graceMs` for exit.
 *      - exits in time   → 'stopped'  (clear the lock if the daemon left it).
 *      - still alive      → 'timeout' (do NOT SIGKILL; tell the user).
 *
 * P22: never reports "stopped" without poll-confirming the PID is gone.
 */
export async function stopRunningNode(deps: StopDeps): Promise<StopResult> {
  const readLock = deps.readLock ?? readLockFile;
  const clearLock = deps.clearLock ?? defaultClearLock;
  const graceMs = deps.graceMs ?? 10_000;
  const pollMs = deps.pollMs ?? 250;

  const info = readLock();
  if (!info) {
    deps.log('No running node found (no lock file).');
    return { outcome: 'no-lock' };
  }

  const { pid, startedAt } = info;

  if (!probeAlive(deps.kill, pid)) {
    deps.log('Node not running (stale lock) — clearing.');
    clearLock();
    return { outcome: 'stale', pid, startedAt };
  }

  // Live daemon — request graceful shutdown. The daemon's own SIGTERM handler
  // drains the runtime, releases the lock, and exits; we only signal + wait.
  deps.log(`🛑 Stopping Synapseia node (pid ${pid}, started ${startedAt})...`);
  try {
    deps.kill(pid, 'SIGTERM');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      // Raced: died between probe and signal. Same end-state as stale.
      deps.log('Node not running (stale lock) — clearing.');
      clearLock();
      return { outcome: 'stale', pid, startedAt };
    }
    throw err;
  }

  const deadline = graceMs;
  let waited = 0;
  while (waited < deadline) {
    await deps.sleep(pollMs);
    waited += pollMs;
    if (!probeAlive(deps.kill, pid)) {
      deps.log(`✅ Node (pid ${pid}) stopped.`);
      // The daemon normally clears its own lock on graceful exit; clear any
      // residue best-effort so a crash mid-shutdown doesn't strand a lock.
      clearLock();
      return { outcome: 'stopped', pid, startedAt };
    }
  }

  // Timed out. Do NOT escalate to SIGKILL automatically — the operator decides.
  deps.log(
    `Node pid ${pid} did not exit after SIGTERM; re-run \`synapseia stop\` or \`kill -9 ${pid}\` manually.`,
  );
  return { outcome: 'timeout', pid, startedAt };
}
