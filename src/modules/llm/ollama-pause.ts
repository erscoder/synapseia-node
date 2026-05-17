/**
 * ollama-pause.ts — Bug 27 (2026-05-17) — Pause Ollama daemon during DiLoCo
 * training on memory-constrained containers.
 *
 * Problem
 * -------
 * DiLoCo Qwen2.5-7B has a peak RSS of ~25-30 GB while loading + first
 * inner-step. Ollama (when running with one or more 7B models warm) holds
 * an additional ~8-12 GB of resident weights. On RunPod / Docker pods in
 * the 40-80 GB tier we cleared the Bug 21 container-class gate
 * (`HEARTBEAT_DILOCO_MIN_CONTAINER_MB = 40 GB`) but the simultaneous
 * Ollama footprint pushes total RSS over the cgroup limit. The kernel
 * OOM-killer reaps the heaviest tenant — diloco_train.py — typically
 * around 94 % of the weight-load step. Verified live on pod A40
 * (cgroup 46.6 GB) on 2026-05-17.
 *
 * Strategy
 * --------
 * Before spawning DiLoCo, if the container total is *below* a configurable
 * threshold (default 80 GB) and Ollama is currently running, SIGTERM the
 * `ollama serve` daemon, wait for port 11434 to go cold, then run DiLoCo.
 * In a `finally` block, regardless of success/failure, restart `ollama
 * serve` detached. The handle returned by `maybePauseOllamaForDiloco`
 * carries the boolean flag the matching restart needs — there is no
 * implicit global state so the call is safe under concurrent (theoretical)
 * DiLoCo invocations.
 *
 * Tradeoffs documented for the reviewer
 * -------------------------------------
 *   P2 (fail-closed identity): pkill failure OR start failure do NOT
 *     block DiLoCo. The decision to run DiLoCo was already made upstream
 *     (Bug 21 container gate + backpressure slot acquired). If Ollama
 *     refuses to die we log a WARN and proceed; the worst case is the
 *     same OOM-kill we were trying to prevent — i.e. status quo. If
 *     restart fails after DiLoCo we log WARN and let the next heartbeat
 *     re-probe pick it up. This is INTENTIONAL fail-open because the
 *     pause is an *opportunistic* memory mitigation, not a security
 *     boundary.
 *   P3 (race): between the `isOllamaRunning` check and the pause, a
 *     concurrent code path could in theory start Ollama. In practice
 *     Ollama is started once at boot by the operator (or installer) and
 *     not re-spawned mid-session by node code. Per-node DiLoCo
 *     concurrency is already serialized to 1 by the backpressure slot.
 *     If both invariants ever break (multi-WO accept), the handle still
 *     restores the daemon (worst case: brief double-start, second exits
 *     with EADDRINUSE).
 *   P10 (lying comments): every promise / fallback path here has a
 *     matching `if`. Nothing is "assumed safe".
 *   P28 (constant bump): `DILOCO_OLLAMA_PAUSE_THRESHOLD_MB` lives in
 *     this file and is overridable via env var of the same name. The
 *     env override is documented adjacent to the constant; if the
 *     DiLoCo / Ollama footprint changes in the future, the threshold
 *     and its env knob are updated together.
 *   P24 (memory signal probe): we explicitly do NOT use `os.freemem()`
 *     here — the gating signal is *container total* (Bug 21 boot
 *     memoized), which is the only deterministic per-process number
 *     that does not flap with workload pressure.
 */

import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { getContainerTotalMemMB } from '../heartbeat/container-mem';
import logger from '../../utils/logger';

/**
 * Threshold (in MB) below which Ollama is paused during DiLoCo. Default
 * 80 000 MB ≈ 80 GB — pods at or above this size have enough headroom
 * for both DiLoCo and Ollama coexisting. Below it we make room.
 *
 * Operators can override via env `DILOCO_OLLAMA_PAUSE_THRESHOLD_MB`.
 * Resolved ONCE per process at module load — the container size is
 * process-stable so re-reading the env at runtime would be noise.
 */
export const DILOCO_OLLAMA_PAUSE_THRESHOLD_MB: number = (() => {
  const raw = process.env.DILOCO_OLLAMA_PAUSE_THRESHOLD_MB;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 80_000;
})();

/** Ollama localhost endpoint we probe + later expect to revive on. */
const OLLAMA_HEALTH_URL = 'http://localhost:11434/api/tags';

/** Max poll for the SIGTERM'd daemon to vacate port 11434. */
const STOP_POLL_TIMEOUT_MS = 10_000;
/** Max poll for the restarted daemon to answer /api/tags. */
const START_POLL_TIMEOUT_MS = 30_000;
/** Interval between health probes during stop/start waits. */
const POLL_INTERVAL_MS = 500;
/** Per-probe HTTP timeout — Ollama responds in <50ms when healthy. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Snapshot of the pre-pause state. Returned from
 * `maybePauseOllamaForDiloco` and passed back to
 * `maybeRestartOllamaAfterDiloco`. `wasRunning=false` means restart is a
 * no-op (either threshold-not-met OR Ollama was already down).
 */
export interface OllamaPauseHandle {
  wasRunning: boolean;
  pausedAt: number;
}

/* -------------------------------------------------------------------------- */
/* Test-injection points                                                       */
/* -------------------------------------------------------------------------- */
/* We inject `fetch` and `spawn` through module-private setters rather than
 * import-namespace mocks because (a) `global.fetch` mocking via `jest.spyOn`
 * is fragile under ESM jest mode and (b) `child_process.spawn` cannot be
 * spied on after the module captured the binding. Matches the pattern used
 * in `container-mem.ts` (`__setReadFileSyncForTests`). Production code
 * never calls the setters. */

type FetchFn = typeof fetch;
type SpawnFn = (
  cmd: string,
  args: string[],
  options: Record<string, unknown>,
) => ChildProcess;

let fetchImpl: FetchFn = (input, init) => fetch(input as RequestInfo, init);
let spawnImpl: SpawnFn = (cmd, args, options) =>
  realSpawn(cmd, args as readonly string[], options as never) as ChildProcess;

/** Test-only override. Pass `null` to restore the real `fetch`. */
export function __setFetchForTests(fn: FetchFn | null): void {
  fetchImpl = fn ?? ((input, init) => fetch(input as RequestInfo, init));
}

/** Test-only override. Pass `null` to restore the real `spawn`. */
export function __setSpawnForTests(fn: SpawnFn | null): void {
  spawnImpl =
    fn ??
    ((cmd, args, options) =>
      realSpawn(cmd, args as readonly string[], options as never) as ChildProcess);
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Decide whether to pause Ollama for an imminent DiLoCo spawn.
 *
 * Returns a handle that MUST be passed to
 * `maybeRestartOllamaAfterDiloco` in a `finally` block. If the container
 * is at or above `DILOCO_OLLAMA_PAUSE_THRESHOLD_MB`, or Ollama is not
 * running, the handle's `wasRunning` is false and the restart call is
 * a no-op. Fail-open: a failed pkill is logged but the function returns
 * normally so the caller can still attempt DiLoCo.
 */
export async function maybePauseOllamaForDiloco(): Promise<OllamaPauseHandle> {
  const containerMb = getContainerTotalMemMB();
  if (containerMb >= DILOCO_OLLAMA_PAUSE_THRESHOLD_MB) {
    return { wasRunning: false, pausedAt: 0 };
  }
  const running = await isOllamaRunning();
  if (!running) {
    return { wasRunning: false, pausedAt: 0 };
  }
  logger.warn(
    `[Bug 27] Container ${containerMb}MB < ${DILOCO_OLLAMA_PAUSE_THRESHOLD_MB}MB threshold; pausing Ollama for DiLoCo`,
  );
  await stopOllamaDaemon();
  return { wasRunning: true, pausedAt: Date.now() };
}

/**
 * Counterpart to `maybePauseOllamaForDiloco`. MUST be called in a
 * `finally` block so the daemon comes back regardless of DiLoCo
 * success/failure. Restart failure is logged WARN and swallowed: the
 * next heartbeat will re-probe and the cap-strip filter will keep
 * inference WOs off this node until the daemon answers again.
 */
export async function maybeRestartOllamaAfterDiloco(
  handle: OllamaPauseHandle,
): Promise<void> {
  if (!handle.wasRunning) return;
  const elapsedSec = Math.round((Date.now() - handle.pausedAt) / 1000);
  logger.info(`[Bug 27] Restarting Ollama after ${elapsedSec}s pause`);
  try {
    await startOllamaDaemon();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[Bug 27] Ollama restart did not confirm within ${START_POLL_TIMEOUT_MS / 1000}s: ${msg}. Next heartbeat will re-probe.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Probe Ollama health via /api/tags. Single 2 s timeout; any failure
 * (connection refused, timeout, non-2xx) is treated as "not running".
 */
async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetchImpl(OLLAMA_HEALTH_URL, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * SIGTERM all `ollama serve` processes and poll until port 11434 stops
 * answering. Fail-open: pkill non-zero exit (e.g. nothing matched, or
 * Linux capability mismatch) is logged WARN and we still poll —
 * isOllamaRunning will quickly return false in that branch.
 *
 * The 10 s ceiling matches Ollama's typical SIGTERM-to-graceful-exit
 * window; if it has not exited by then we proceed anyway (the OOM
 * fail-open posture documented at the top of this file).
 */
async function stopOllamaDaemon(): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const p = spawnImpl('pkill', ['-TERM', '-f', 'ollama serve'], {
        stdio: 'ignore',
      });
      p.on('close', settle);
      p.on('error', (err) => {
        logger.warn(
          `[Bug 27] pkill spawn failed: ${err instanceof Error ? err.message : String(err)}; proceeding to wait-poll`,
        );
        settle();
      });
    } catch (err) {
      logger.warn(
        `[Bug 27] pkill threw synchronously: ${err instanceof Error ? err.message : String(err)}; proceeding to wait-poll`,
      );
      settle();
    }
  });
  await waitUntil(
    async () => !(await isOllamaRunning()),
    STOP_POLL_TIMEOUT_MS,
  );
}

/**
 * Spawn `ollama serve` detached + unref'd so the parent (this node CLI)
 * can exit without leaving an orphan zombie. Poll /api/tags until it
 * responds or 30 s elapses, then throw — caller is the one that
 * decides what WARN to emit.
 */
async function startOllamaDaemon(): Promise<void> {
  try {
    const child = spawnImpl('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref?.();
  } catch (err) {
    throw new Error(
      `spawn(ollama serve) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const up = await waitUntil(
    () => isOllamaRunning(),
    START_POLL_TIMEOUT_MS,
  );
  if (!up) {
    throw new Error('Ollama did not respond to /api/tags after spawn');
  }
}

/**
 * Generic poll-until-truthy with real `setTimeout` waits (not jest
 * fake timers — P29: the test should exercise the real timing semantics
 * via short timeouts injected via the test helpers).
 *
 * Returns true on success, false on deadline expiry.
 */
async function waitUntil(
  pred: () => Promise<boolean>,
  deadlineMs: number,
): Promise<boolean> {
  const start = Date.now();
  // First check is immediate so callers don't pay a 500 ms tax on the
  // fast path.
  if (await pred()) return true;
  while (Date.now() - start < deadlineMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (await pred()) return true;
  }
  return false;
}
