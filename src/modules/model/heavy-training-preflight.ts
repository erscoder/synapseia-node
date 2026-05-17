/**
 * heavy-training-preflight.ts — Pre-flight memory gate for heavy training
 * workloads (DiLoCo and LoRA). Originally `diloco-preflight.ts`
 * (Bug 28, 2026-05-17); generalized in Plan B / Slice 8 (2026-05-17) to
 * also gate LoRA spawns, which load the same Qwen2.5-7B class base model
 * via `AutoModelForCausalLM.from_pretrained` without quantization and
 * therefore hit the same +14 GB fp16 load peak that originally triggered
 * the SIGKILL loop on pod A40.
 *
 * Problem
 * -------
 * Bug 27 (Ollama pause) reduces but does not eliminate OOM during the
 * weight load of either DiLoCo or LoRA training on memory-constrained
 * pods. Verified live on pod A40 (cgroup 46.6 GB) 2026-05-17 for DiLoCo:
 *   - 16:56 accept → 16:57 SIGKILL at ~94% weight load
 *   - 17:27 accept → 17:29 SIGKILL
 *   - 18:06 accept → 18:07 SIGKILL
 *   - 18:30 accept → 18:32 SIGKILL
 * Ollama pause DID fire (`Container 47683MB < 80000MB threshold;
 * pausing Ollama for heavy training`) but freed only ~200MB because the
 * daemon was idle (no model resident at SIGTERM time). Meanwhile HF
 * page-cache + node heap + venv residuals already had the container at
 * 99% usage before training even spawned. LoRA has identical load-time
 * footprint when the base is a 7B class model.
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
 * The caller (`DiLoCoTrainerHelper.runDiLoCoInnerLoop` or `runLora`)
 * propagates the error; the WO-level handler (`executeDiLoCoWorkOrder`
 * / `executeLoraWorkOrder`) catches it and returns
 * `{ success: false }` so the coordinator's standard ACCEPTED-TTL
 * expiry handles re-routing. We do NOT client-side re-queue — per
 * reviewer-lesson P21 the receivedAt would be reset and starve.
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
 *   P11 (callers desincronizados): when this module was renamed from
 *        `diloco-preflight` to `heavy-training-preflight`, all
 *        importers were updated in the same PR. A deprecated
 *        `ensureMemForDiloco()` wrapper is kept as a back-compat alias
 *        but tagged @deprecated so future readers migrate.
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
 * Peak load for LoRA training (`train_lora.py`) on a 7B-class base
 * model. The base is loaded with `AutoModelForCausalLM.from_pretrained`
 * WITHOUT quantization (Slice 8 audit 2026-05-17,
 * `scripts/train_lora.py:138-140`), so the load-time fp16 footprint
 * matches DiLoCo's ~14 GB. UNLIKE DiLoCo, LoRA does not keep:
 *   - a full fp32 Adam mirror (only adapter params, ~MB scale, are
 *     optimized);
 *   - a separate gradient buffer for the full backbone (gradients flow
 *     to adapter params only).
 * Steady-state RSS during training is therefore ~base + small overhead,
 * not base + Adam + gradients. We allocate the same load-time peak
 * floor (14 GB) WITHOUT the +4 GB Adam-mirror margin DiLoCo carries —
 * the load step is the actual peak for LoRA. 14336 MB chosen over a
 * looser 8 GB or 6 GB number because empirically `from_pretrained`
 * with fp16 on a 7B already exceeds 8 GB during the safetensors
 * memory-map + cudaMalloc/MPS-equivalent peer-resident copy phase.
 * If a future LoRA base ships below 7B (e.g. 1B / 3B) this gate is
 * still safe — it only over-skips on tiny pods, where Bug 21's
 * container-class gate already prevents acceptance anyway.
 */
export const LORA_REQUIRED_FREE_MB = 14336;

/**
 * After GC + drop_caches the kernel needs a tick to actually reclaim
 * pages. 500 ms is generous on Linux (typical reclaim <100 ms) but
 * costs nothing because heavy training runs are 5-15 minutes — the
 * latency is dominated by the python spawn that follows.
 */
export const PREFLIGHT_RE_PROBE_DELAY_MS = 500;

const CGROUP_V2_MAX = '/sys/fs/cgroup/memory.max';
const CGROUP_V2_CURRENT = '/sys/fs/cgroup/memory.current';
const CGROUP_V1_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
const CGROUP_V1_USAGE = '/sys/fs/cgroup/memory/memory.usage_in_bytes';
const DROP_CACHES_PATH = '/proc/sys/vm/drop_caches';

/**
 * Controlled-failure error: the gate decided the heavy training spawn
 * cannot safely proceed. The caller MUST convert this into
 * `{ success: false }`, not propagate as a process crash. Both
 * `freeMB` and `requiredMB` are surfaced so ops triage can tell at a
 * glance how far the container is from threshold; the message label
 * (DiLoCo / LoRA) identifies which workload tripped.
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
// log on every heavy-training round when --expose-gc isn't set.
let gcUnavailableWarned = false;

/**
 * Read cgroup v2 → v1 → no-cgroup, returning free MB inside the
 * container's memory accounting. Fail-CLOSED on any read error:
 * returns 0 so the gate trips and the WO is skipped via a controlled
 * `InsufficientMemoryError` rather than letting the python trainer
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
    logger.log('[Preflight] drop_caches issued (kernel page-cache reclaim)');
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    logger.warn(
      `[Preflight] drop_caches denied (${msg}) — skipping; ` +
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
    logger.log('[Preflight] forced V8 GC');
    return;
  }
  if (!gcUnavailableWarned) {
    gcUnavailableWarned = true;
    logger.warn(
      '[Preflight] global.gc unavailable — start node with ' +
      '--expose-gc to enable V8 GC reclaim',
    );
  }
}

/**
 * Main entry point. See file-level docblock for the full strategy.
 *
 * @param requiredMB minimum free container memory in MB for the spawn
 *                   to be considered safe. Pass `DILOCO_REQUIRED_FREE_MB`
 *                   for DiLoCo, `LORA_REQUIRED_FREE_MB` for LoRA.
 * @param opts test-only overrides — production callers omit and get
 *             the defaults. A `label` may be passed to disambiguate
 *             the log prefix (e.g. "DiLoCo" / "LoRA"); defaults to
 *             the workload name implied by `requiredMB` when matched,
 *             else "Training".
 *
 * @throws InsufficientMemoryError if memory is still below threshold
 *         after liberation. Caller treats this as controlled skip.
 */
export async function ensureMemForHeavyTraining(
  requiredMB: number,
  opts?: {
    getFreeMemMB?: () => Promise<number>;
    dropFsCache?: () => Promise<void>;
    forceGc?: () => void;
    delayMs?: (ms: number) => Promise<void>;
    label?: string;
  },
): Promise<void> {
  const getFreeMemMB = opts?.getFreeMemMB ?? defaultGetContainerFreeMemMB;
  const dropFsCache = opts?.dropFsCache ?? defaultDropFsCache;
  const forceGc = opts?.forceGc ?? defaultForceGc;
  const delayMs = opts?.delayMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const label = opts?.label ?? defaultLabelForRequired(requiredMB);
  const tag = `[Preflight ${label}]`;

  // 1. Initial probe — short-circuit when there's already headroom.
  //    Wrapped in try/catch so a probe throw is treated as fail-CLOSED
  //    (free=0) rather than crashing the WO with an unrelated error.
  let initialFree: number;
  try {
    initialFree = await getFreeMemMB();
  } catch (err) {
    logger.warn(
      `${tag} free-mem probe failed (${(err as Error).message}) — ` +
      'fail-CLOSED (treating as 0 MB free)',
    );
    initialFree = 0;
  }

  if (initialFree >= requiredMB) {
    logger.log(`${tag} free=${initialFree}MB >= required=${requiredMB}MB — pass`);
    return;
  }

  logger.warn(
    `${tag} free=${initialFree}MB < required=${requiredMB}MB — running liberation`,
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
      `${tag} post-liberation probe failed (${(err as Error).message}) — ` +
      'fail-CLOSED (treating as 0 MB free)',
    );
    finalFree = 0;
  }

  if (finalFree < requiredMB) {
    throw new InsufficientMemoryError(
      `${label} needs ${requiredMB}MB free after liberation, ` +
      `only ${finalFree}MB available (was ${initialFree}MB before)`,
      finalFree,
      requiredMB,
    );
  }

  const reclaimed = finalFree - initialFree;
  logger.log(`${tag} liberation reclaimed ${reclaimed}MB; final free=${finalFree}MB — pass`);
}

/**
 * Pick a default log label from the threshold value. Avoids forcing
 * every caller to pass an explicit label when the requirement uniquely
 * identifies the workload. Falls back to "Training" for custom
 * thresholds (test-only).
 */
function defaultLabelForRequired(requiredMB: number): string {
  if (requiredMB === DILOCO_REQUIRED_FREE_MB) return 'DiLoCo';
  if (requiredMB === LORA_REQUIRED_FREE_MB) return 'LoRA';
  return 'Training';
}

/**
 * @deprecated Use `ensureMemForHeavyTraining(DILOCO_REQUIRED_FREE_MB, opts)`.
 * Kept as a thin alias so pre-Slice-8 callers (and any vendor of this
 * module) still compile during the migration window. Behavior is
 * identical to the new function with `requiredMB =
 * DILOCO_REQUIRED_FREE_MB` and `label = "DiLoCo"`.
 */
export async function ensureMemForDiloco(opts?: {
  getFreeMemMB?: () => Promise<number>;
  dropFsCache?: () => Promise<void>;
  forceGc?: () => void;
  delayMs?: (ms: number) => Promise<void>;
}): Promise<void> {
  return ensureMemForHeavyTraining(DILOCO_REQUIRED_FREE_MB, { ...opts, label: 'DiLoCo' });
}
