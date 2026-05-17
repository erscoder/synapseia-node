/**
 * diloco-preflight.ts — DiLoCo pre-flight memory gate (Bug 28, 2026-05-17).
 *
 * Problem
 * -------
 * Bug 27 (Ollama pause) reduces but does not eliminate OOM during DiLoCo
 * weight load on memory-constrained pods. Verified live on pod A40
 * (cgroup 46.6 GB) 2026-05-17:
 *   - 16:56 accept → 16:57 SIGKILL at ~94% weight load
 *   - 17:27 accept → 17:29 SIGKILL
 *   - 18:06 accept → 18:07 SIGKILL
 *   - 18:30 accept → 18:32 SIGKILL
 * Ollama pause DID fire (`Container 47683MB < 80000MB threshold;
 * pausing Ollama for DiLoCo`) but freed only ~200MB because the daemon
 * was idle (no model resident at SIGTERM time). Meanwhile HF page-cache
 * + node heap + venv residuals already had the container at 99% usage
 * before DiLoCo even spawned.
 *
 * Strategy
 * --------
 * AFTER Bug 27 pauses Ollama, BEFORE the python spawn:
 *   1. probe cgroup free memory;
 *   2. if below threshold, actively release memory we control
 *      (V8 GC + kernel FS page-cache drop);
 *   3. re-probe;
 *   4. if still below threshold, throw `InsufficientMemoryError`.
 *
 * The caller (`DiLoCoTrainerHelper.runDiLoCoInnerLoop`) propagates the
 * error; `executeDiLoCoWorkOrder` catches it and returns
 * `{ success: false }` so the coordinator's standard ACCEPTED-TTL
 * expiry handles re-routing. We do NOT client-side re-queue the WO —
 * per reviewer-lesson P21 the receivedAt would be reset and starve.
 *
 * Reviewer-lesson alignment
 * -------------------------
 *   P10 (no lying comments): every behavior documented matches code.
 *   P24 (memory pressure probe): default to fail-CLOSED on probe
 *        error. Container is presumed unsafe until proven safe — a
 *        broken probe must trip the gate, not silently bypass it.
 *   P21 (re-queue preserves receivedAt): the controlled skip path
 *        does NOT call push/requeue on the local queue. Coord cron
 *        re-creates the round after ACCEPTED TTL expires.
 *   P29 (mocks not silencers): the spec asserts numeric reclaim
 *        deltas and error fields, not just "didn't throw".
 */

import { promises as fs } from 'fs';
import { freemem } from 'os';
import logger from '../../utils/logger';

/**
 * Peak load for Qwen2.5-7B fp16 on the current `diloco_train.py`
 * code path is ~14 GB observed (weights ~14 GB + activations + Adam
 * state in CPU fp32 mirror for AdamW). 18 GB = 14 GB peak + ~4 GB
 * margin for the Python interpreter + transformers/torch heap + the
 * window between probe and actual peak. Tuned empirically against
 * the 2026-05-17 pod-A40 incident.
 */
export const DILOCO_REQUIRED_FREE_MB = 18432;

/**
 * After GC + drop_caches the kernel needs a tick to actually reclaim
 * pages. 500 ms is generous on Linux (typical reclaim <100 ms) but
 * costs nothing because DiLoCo runs are 5-15 minutes — the latency
 * is dominated by the python spawn that follows.
 */
export const PREFLIGHT_RE_PROBE_DELAY_MS = 500;

const CGROUP_V2_MAX = '/sys/fs/cgroup/memory.max';
const CGROUP_V2_CURRENT = '/sys/fs/cgroup/memory.current';
const CGROUP_V1_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
const CGROUP_V1_USAGE = '/sys/fs/cgroup/memory/memory.usage_in_bytes';
const DROP_CACHES_PATH = '/proc/sys/vm/drop_caches';

/**
 * Controlled-failure error: the gate decided DiLoCo cannot safely
 * spawn. The caller MUST convert this into `{ success: false }`, not
 * propagate as a process crash.
 */
export class InsufficientMemoryError extends Error {
  constructor(
    message: string,
    public readonly freeMB: number,
    public readonly requiredMB: number,
  ) {
    super(message);
    this.name = 'InsufficientMemoryError';
  }
}

// One-time WARN guard for the global.gc message so we don't spam the
// log on every DiLoCo round when --expose-gc isn't set.
let gcUnavailableWarned = false;

/**
 * Read cgroup v2 → v1 → no-cgroup, returning free MB inside the
 * container's memory accounting. Fail-CLOSED on any read error:
 * returns 0 so the gate trips and the WO is skipped via a controlled
 * `InsufficientMemoryError` rather than letting `diloco_train.py`
 * spawn into a container that may or may not have headroom.
 *
 * Fallback chain:
 *   1. cgroup v2 (`memory.max` + `memory.current`) — Docker/Podman
 *      with cgroupv2 (Ubuntu 22+, RHEL 9+, RunPod 2024+).
 *   2. cgroup v1 (`memory.limit_in_bytes` + `memory.usage_in_bytes`)
 *      — older Docker hosts.
 *   3. host-wide `os.freemem()` — bare-metal / no cgroup files
 *      (developer laptop). Last-resort, still gates correctly.
 *
 * The v2 path treats `max` value "max" (no limit set) as host-wide:
 * falls through to `freemem()` rather than reporting infinity, so
 * the gate still works on unlimited containers running real probes.
 */
export async function defaultGetContainerFreeMemMB(): Promise<number> {
  // cgroup v2
  try {
    const [maxRaw, currentRaw] = await Promise.all([
      fs.readFile(CGROUP_V2_MAX, 'utf8'),
      fs.readFile(CGROUP_V2_CURRENT, 'utf8'),
    ]);
    const maxTrim = maxRaw.trim();
    const current = Number(currentRaw.trim());
    if (maxTrim === 'max') {
      // No container limit set — use host freemem.
      const hostFree = Math.floor(freemem() / 1024 / 1024);
      return hostFree;
    }
    const max = Number(maxTrim);
    if (Number.isFinite(max) && Number.isFinite(current) && max > 0) {
      return Math.floor((max - current) / 1024 / 1024);
    }
  } catch {
    // fall through to v1
  }

  // cgroup v1
  try {
    const [limitRaw, usageRaw] = await Promise.all([
      fs.readFile(CGROUP_V1_LIMIT, 'utf8'),
      fs.readFile(CGROUP_V1_USAGE, 'utf8'),
    ]);
    const limit = Number(limitRaw.trim());
    const usage = Number(usageRaw.trim());
    // v1 reports an absurd sentinel (~9.2e18) for "no limit".
    if (Number.isFinite(limit) && Number.isFinite(usage) && limit > 0 && limit < 1e18) {
      return Math.floor((limit - usage) / 1024 / 1024);
    }
  } catch {
    // fall through to host
  }

  // Host fallback (developer laptop, bare metal). `os.freemem()` on
  // macOS Node 22+ now matches vm_stat (reviewer-lesson P24 update
  // 2026-05-11), so this is safe enough for dev. Container probe
  // failure on a real prod pod is the actual fail-CLOSED branch
  // below, NOT this line.
  try {
    return Math.floor(freemem() / 1024 / 1024);
  } catch {
    // Genuinely broken — fail-CLOSED.
    return 0;
  }
}

/**
 * Best-effort kernel page-cache drop. `echo 3 > /proc/sys/vm/drop_caches`
 * reclaims pagecache + dentries + inodes. Requires CAP_SYS_ADMIN; most
 * container envs deny it (no --cap-add=SYS_ADMIN) and the open/write
 * fails with EACCES / EPERM. Swallow all errors with a single WARN —
 * liberation is best-effort and the re-probe below is the actual gate.
 */
export async function defaultDropFsCache(): Promise<void> {
  try {
    await fs.writeFile(DROP_CACHES_PATH, '3');
    logger.log('[DiLoCo preflight] drop_caches issued (kernel page-cache reclaim)');
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    logger.warn(
      `[DiLoCo preflight] drop_caches denied (${msg}) — skipping; ` +
      'consider running container with --cap-add=SYS_ADMIN',
    );
  }
}

/**
 * Force a V8 major GC if `--expose-gc` was passed. Without that flag
 * `global.gc` is undefined and we WARN exactly once (cron-noise
 * control). Node's incremental GC will still run eventually but
 * cannot be forced from userland without the flag.
 */
export function defaultForceGc(): void {
  const g = (globalThis as { gc?: () => void }).gc;
  if (typeof g === 'function') {
    g();
    logger.log('[DiLoCo preflight] forced V8 GC');
    return;
  }
  if (!gcUnavailableWarned) {
    gcUnavailableWarned = true;
    logger.warn(
      '[DiLoCo preflight] global.gc unavailable — start node with ' +
      '--expose-gc to enable V8 GC reclaim',
    );
  }
}

/**
 * Main entry point. See file-level docblock for the full strategy.
 *
 * Test-only overrides via `opts` let the spec inject deterministic
 * memory readings, gc, drop_caches, and delay. Production callers
 * pass no opts and get the defaults.
 *
 * @throws InsufficientMemoryError if memory is still below threshold
 *         after liberation. Caller treats this as controlled skip.
 */
export async function ensureMemForDiloco(opts?: {
  getFreeMemMB?: () => Promise<number>;
  dropFsCache?: () => Promise<void>;
  forceGc?: () => void;
  delayMs?: (ms: number) => Promise<void>;
}): Promise<void> {
  const getFreeMemMB = opts?.getFreeMemMB ?? defaultGetContainerFreeMemMB;
  const dropFsCache = opts?.dropFsCache ?? defaultDropFsCache;
  const forceGc = opts?.forceGc ?? defaultForceGc;
  const delayMs = opts?.delayMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // 1. Initial probe — short-circuit when there's already headroom.
  //    Wrapped in try/catch so a probe throw is treated as fail-CLOSED
  //    (free=0) rather than crashing the WO with an unrelated error.
  let initialFree: number;
  try {
    initialFree = await getFreeMemMB();
  } catch (err) {
    logger.warn(
      `[DiLoCo preflight] free-mem probe failed (${(err as Error).message}) — ` +
      'fail-CLOSED (treating as 0 MB free)',
    );
    initialFree = 0;
  }

  if (initialFree >= DILOCO_REQUIRED_FREE_MB) {
    logger.log(
      `[DiLoCo preflight] free=${initialFree}MB >= required=${DILOCO_REQUIRED_FREE_MB}MB — pass`,
    );
    return;
  }

  logger.warn(
    `[DiLoCo preflight] free=${initialFree}MB < required=${DILOCO_REQUIRED_FREE_MB}MB — running liberation`,
  );

  // 2. Active liberation: V8 GC then kernel drop_caches then settle.
  forceGc();
  await dropFsCache();
  await delayMs(PREFLIGHT_RE_PROBE_DELAY_MS);

  // 3. Re-probe. Same fail-CLOSED treatment as the initial probe.
  let finalFree: number;
  try {
    finalFree = await getFreeMemMB();
  } catch (err) {
    logger.warn(
      `[DiLoCo preflight] post-liberation probe failed (${(err as Error).message}) — ` +
      'fail-CLOSED (treating as 0 MB free)',
    );
    finalFree = 0;
  }

  if (finalFree < DILOCO_REQUIRED_FREE_MB) {
    throw new InsufficientMemoryError(
      `DiLoCo needs ${DILOCO_REQUIRED_FREE_MB}MB free after liberation, ` +
      `only ${finalFree}MB available (was ${initialFree}MB before)`,
      finalFree,
      DILOCO_REQUIRED_FREE_MB,
    );
  }

  const reclaimed = finalFree - initialFree;
  logger.log(
    `[DiLoCo preflight] liberation reclaimed ${reclaimed}MB; final free=${finalFree}MB — pass`,
  );
}
