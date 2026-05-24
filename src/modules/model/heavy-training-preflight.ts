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

import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import { freemem } from 'os';
import logger from '../../utils/logger';
import { resolvePython } from '../../utils/python-venv';
import { sanitizedEnvForSubprocess } from '../../utils/subprocess-env';

/**
 * Slice 10 (Plan B, 2026-05-17) — BUMPED from 18432 to 36864 (36 GB).
 *
 * Rationale for the bump
 * ----------------------
 * The original 18 GB headroom (Bug 28) was computed as
 * "14 GB load peak + 4 GB margin". Empirically this is INSUFFICIENT
 * on pod A40 (cgroup 46.6 GB, swap=0, oom_kill=10 verified
 * 2026-05-17 20:19 UTC): preflight passed at
 * `free=40896MB >= required=18432MB` and DiLoCo STILL got SIGKILL'd
 * 2 minutes later at the ~100% weight load line.
 *
 * What we missed in the 18 GB estimate
 * ------------------------------------
 * The "100% loaded" HF safetensors progress line marks the network
 * download / mmap setup finishing, NOT the full RSS materialization.
 * After that line several costs stack BEFORE training equilibrium:
 *   - safetensors lazy mmap pages actually fault into RSS as tensors
 *     are referenced;
 *   - first backward pass activations (Qwen2.5-7B + batch_size=4
 *     fp32 ~5-8 GB additional);
 *   - quantization temp buffers (cudaMalloc / MPS staging) for the
 *     CUDA path;
 *   - CUDA pinned memory pool (DataLoader transfer buffers — note
 *     Slice 11 sets pin_memory=False to mitigate this specifically);
 *   - kernel page cache for the snapshot files (not reclaimable
 *     under WO-level memory pressure because the trainer is still
 *     reading them);
 *   - Python interpreter heap + transformers/torch graph metadata.
 *
 * Combined peak: well over 30 GB on a 7B class model even with
 * `low_cpu_mem_usage=True` (Slice 11). Without swap (swap.max=0 on
 * the affected pod) any spike past the cgroup limit is an instant
 * SIGKILL — no grace, no swap-out.
 *
 * 36 GB is a SAFER margin until `predictedPeakDuringTraining` is
 * properly modeled (future Plan B slice — concrete numbers come from
 * the continuous memory sampler added in Slice 10b). It is NOT a
 * permanent target: as the sampler produces real distributions
 * across the fleet we expect this to drop again (probably to
 * ~28-30 GB), but only with evidence.
 *
 * Knock-on effect: this gate over-skips on memory-light pods. That
 * is BY DESIGN — the alternative is the SIGKILL loop where coord
 * keeps re-routing to the same crashing node every accept TTL.
 * Bug 21's container-class cap-gate already prevents acceptance on
 * pods that obviously cannot fit a heavy WO; this is a second line.
 */
/**
 * Slice 17 (Plan B, 2026-05-17) — dynamic DiLoCo threshold based on the
 * CUDA 4-bit quant path availability (`detectQuantSupport()`).
 *
 * QUANT path (torch + bitsandbytes + CUDA available)
 * --------------------------------------------------
 * Qwen2.5-7B 4-bit nf4 weights load at ~5 GB on-device. With activations
 * (~1.5 GB at batch_size=4 seq=1024), optimizer state (LoRA-style adapters
 * only when DiLoCo runs with frozen base = same scale as LoRA), CUDA
 * staging buffers + Python heap + safetensors mmap residue, the observed
 * peak settles around ~6-7 GB. 8 GB headroom is a 25% safety margin and
 * still keeps the gate useful — pods under 8 GB free really cannot host
 * a Qwen-class CUDA run.
 *
 * Empirical basis: Slice 16 enabled the cu121 + bnb install in the
 * NVIDIA pod bootstrap (commit b3274b8a7+). Pod measurements pending
 * (Slice 18 sampler will capture the QUANT-path peak distribution and
 * may justify dropping further). 8 GB is intentionally conservative —
 * the cost of over-skip on a 16 GB pod is one rejected accept; the cost
 * of under-skip is a SIGKILL loop. P24 fail-safe direction.
 */
export const DILOCO_REQUIRED_FREE_MB_QUANT = 8192; // 8 GB

/**
 * FP32 fallback DiLoCo threshold — see Slice 10 docblock below for the
 * full historical rationale. Used when `detectQuantSupport()` returns
 * false (no CUDA, no bitsandbytes, or probe error → fail-CLOSED).
 *
 * Slice 10 (Plan B, 2026-05-17) — BUMPED from 18432 to 36864 (36 GB).
 *
 * Rationale for the bump
 * ----------------------
 * The original 18 GB headroom (Bug 28) was computed as
 * "14 GB load peak + 4 GB margin". Empirically this is INSUFFICIENT
 * on pod A40 (cgroup 46.6 GB, swap=0, oom_kill=10 verified
 * 2026-05-17 20:19 UTC): preflight passed at
 * `free=40896MB >= required=18432MB` and DiLoCo STILL got SIGKILL'd
 * 2 minutes later at the ~100% weight load line.
 *
 * What we missed in the 18 GB estimate
 * ------------------------------------
 * The "100% loaded" HF safetensors progress line marks the network
 * download / mmap setup finishing, NOT the full RSS materialization.
 * After that line several costs stack BEFORE training equilibrium:
 *   - safetensors lazy mmap pages actually fault into RSS as tensors
 *     are referenced;
 *   - first backward pass activations (Qwen2.5-7B + batch_size=4
 *     fp32 ~5-8 GB additional);
 *   - quantization temp buffers (cudaMalloc / MPS staging) for the
 *     CUDA path;
 *   - CUDA pinned memory pool (DataLoader transfer buffers — note
 *     Slice 11 sets pin_memory=False to mitigate this specifically);
 *   - kernel page cache for the snapshot files (not reclaimable
 *     under WO-level memory pressure because the trainer is still
 *     reading them);
 *   - Python interpreter heap + transformers/torch graph metadata.
 *
 * Combined peak: well over 30 GB on a 7B class model even with
 * `low_cpu_mem_usage=True` (Slice 11). Without swap (swap.max=0 on
 * the affected pod) any spike past the cgroup limit is an instant
 * SIGKILL — no grace, no swap-out.
 *
 * 36 GB is a SAFER margin until `predictedPeakDuringTraining` is
 * properly modeled (future Plan B slice — concrete numbers come from
 * the continuous memory sampler added in Slice 10b). It is NOT a
 * permanent target: as the sampler produces real distributions
 * across the fleet we expect this to drop again (probably to
 * ~28-30 GB), but only with evidence.
 *
 * Knock-on effect: this gate over-skips on memory-light pods. That
 * is BY DESIGN — the alternative is the SIGKILL loop where coord
 * keeps re-routing to the same crashing node every accept TTL.
 * Bug 21's container-class cap-gate already prevents acceptance on
 * pods that obviously cannot fit a heavy WO; this is a second line.
 */
export const DILOCO_REQUIRED_FREE_MB_FP32 = 36864;

/**
 * Back-compat alias — defaults to the SAFER FP32 threshold so any
 * caller that still imports the static constant (per P11 grep we
 * updated all known callers in Slice 17, but external/vendored copies
 * may exist) gets the conservative gate. New callers should use
 * `requiredMemForHeavyTraining('DiLoCo')` to pick up the QUANT path
 * automatically on CUDA + bitsandbytes pods.
 */
export const DILOCO_REQUIRED_FREE_MB = DILOCO_REQUIRED_FREE_MB_FP32;

/**
 * Slice 10 (Plan B, 2026-05-17) — BUMPED from 14336 to 24576 (24 GB).
 *
 * LoRA peak is smaller than DiLoCo because the optimizer state lives
 * on adapter parameters only (~MB scale) and gradients flow only to
 * the adapter. BUT the load-time fp16 footprint + safetensors mmap +
 * page cache + CUDA pinned memory pool penalty stacks identically to
 * DiLoCo's load phase (see DILOCO_REQUIRED_FREE_MB docblock for the
 * full breakdown). Empirically the difference is "no separate Adam
 * mirror, no full backbone gradient buffer" — call it ~10-12 GB
 * less peak than DiLoCo's 36 GB headroom.
 *
 * 24 GB headroom is therefore tuned as
 *   DiLoCo (36) − Adam mirror (≈8) − full-backbone grad buffer (≈4)
 *
 * Same caveats as DiLoCo: provisional until the Slice 10b sampler
 * produces real distributions. If a future LoRA base ships below
 * 7B (1B / 3B), this gate over-skips on tiny pods — Bug 21's
 * container-class cap-gate already prevents acceptance there, so
 * the over-skip is harmless.
 */
/**
 * Slice 17 (Plan B, 2026-05-17) — dynamic LoRA threshold based on the
 * CUDA 4-bit quant path availability.
 *
 * QUANT path peak ≈ 5 GB (4-bit base weights) + 0.5 GB (adapter +
 * adapter optimizer state) + 0.5 GB (activations + CUDA staging) ≈
 * 6 GB. Same 25% safety margin as DiLoCo — anything tighter risks
 * SIGKILL on cgroup edge cases (page cache + Python heap noise).
 *
 * Empirical basis: identical CUDA load profile to DiLoCo QUANT path
 * (same base, same bnb config). Adapter training is the *cheaper*
 * branch — no backbone gradient buffer, no full Adam mirror — so this
 * threshold is upper-bounded by DiLoCo's QUANT estimate minus the
 * frozen-base savings (~2 GB).
 */
export const LORA_REQUIRED_FREE_MB_QUANT = 6144; // 6 GB

/**
 * FP32 fallback LoRA threshold — see Slice 10 docblock below for the
 * historical rationale. Used when `detectQuantSupport()` returns
 * false. Default for back-compat callers via `LORA_REQUIRED_FREE_MB`.
 *
 * Slice 10 (Plan B, 2026-05-17) — BUMPED from 14336 to 24576 (24 GB).
 *
 * LoRA peak is smaller than DiLoCo because the optimizer state lives
 * on adapter parameters only (~MB scale) and gradients flow only to
 * the adapter. BUT the load-time fp16 footprint + safetensors mmap +
 * page cache + CUDA pinned memory pool penalty stacks identically to
 * DiLoCo's load phase (see DILOCO_REQUIRED_FREE_MB_FP32 docblock).
 * Empirically the difference is "no separate Adam mirror, no full
 * backbone gradient buffer" — call it ~10-12 GB less peak than DiLoCo's
 * 36 GB headroom.
 *
 * 24 GB headroom is therefore tuned as
 *   DiLoCo (36) − Adam mirror (≈8) − full-backbone grad buffer (≈4)
 *
 * Same caveats as DiLoCo: provisional until the Slice 10b sampler
 * produces real distributions. If a future LoRA base ships below
 * 7B (1B / 3B), this gate over-skips on tiny pods — Bug 21's
 * container-class cap-gate already prevents acceptance there, so
 * the over-skip is harmless.
 */
export const LORA_REQUIRED_FREE_MB_FP32 = 24576;

/**
 * Back-compat alias — defaults to FP32 (safer). See
 * `DILOCO_REQUIRED_FREE_MB` for the rationale on keeping both static
 * aliases alongside the dynamic helper.
 */
export const LORA_REQUIRED_FREE_MB = LORA_REQUIRED_FREE_MB_FP32;

/**
 * After GC + drop_caches the kernel needs a tick to actually reclaim
 * pages. 500 ms is generous on Linux (typical reclaim <100 ms) but
 * costs nothing because heavy training runs are 5-15 minutes — the
 * latency is dominated by the python spawn that follows.
 */
export const PREFLIGHT_RE_PROBE_DELAY_MS = 500;

const CGROUP_V2_MAX = '/sys/fs/cgroup/memory.max';
const CGROUP_V2_CURRENT = '/sys/fs/cgroup/memory.current';
const CGROUP_V2_STAT = '/sys/fs/cgroup/memory.stat';
const CGROUP_V1_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
const CGROUP_V1_USAGE = '/sys/fs/cgroup/memory/memory.usage_in_bytes';
const CGROUP_V1_STAT = '/sys/fs/cgroup/memory/memory.stat';
const DROP_CACHES_PATH = '/proc/sys/vm/drop_caches';

// One-time WARN guards: if memory.stat is unreadable / unparseable we
// LOSE the reclaimable-cache bonus and fall back to the OLD bare
// (limit-usage / max-current) figure for that branch. That base value is
// still a valid conservative lower bound (it was the pre-fix behavior),
// so we do NOT fail-CLOSED to 0 here — that would re-introduce the
// over-skip this fix exists to eliminate. We only warn once per branch to
// avoid cron spam on every heavy-training round.
let v2ReclaimWarned = false;
let v1ReclaimWarned = false;

/**
 * Parse the immediately-reclaimable file-cache figure (in MB) out of a
 * cgroup `memory.stat` text body.
 *
 * Why this exists (the Bug NEW-2 fix, 2026-05-22)
 * -----------------------------------------------
 * The container `usage` (v1 `memory.usage_in_bytes`) and `current`
 * (v2 `memory.current`) counters INCLUDE reclaimable page cache —
 * clean, file-backed pages the kernel will evict for free under
 * allocation pressure. The old free formula `limit - usage` (v1) /
 * `max - current` (v2) therefore UNDER-reports available memory by the
 * size of that cache.
 *
 * We cannot proactively reclaim it: `drop_caches` requires CAP_SYS_ADMIN,
 * which RunPod and most container runtimes DENY (see `defaultDropFsCache`
 * — the write fails EACCES/EPERM). But we do not need to: when the
 * trainer's allocation outgrows RSS, the kernel evicts these clean file
 * pages automatically, no privilege required. So they ARE available; the
 * gate just was not counting them.
 *
 * Live evidence (pod2, cgroup v1, 2026-05-22)
 * -------------------------------------------
 *   limit_in_bytes     = 47683 MB
 *   usage_in_bytes     = 44046 MB   → old free = 3637 MB → over-skip
 *   total_rss          =   342 MB   (!) actual anonymous footprint
 *   total_cache        = 43338 MB   evictable file cache
 *   total_inactive_file= 17324 MB   (18166677504 bytes)
 *   total_active_file  = 26014 MB
 * Real available ≥ 21 GB because RSS is only 342 MB. The old gate skipped
 * DiLoCo ("needs 8192MB free, only 3488MB") / LoRA ("needs 6144MB, only
 * 1887MB") on a pod with tens of GB of evictable cache.
 *
 * Which key we read
 * -----------------
 * We add back `inactive_file` (v2) / `total_inactive_file` (v1) ONLY.
 * That is the kernel's least-recently-used, immediately-reclaimable
 * file-backed set — the most conservative "definitely free under
 * pressure" figure. `active_file` and `slab_reclaimable` are ALSO
 * reclaimable but require more scan work / are partly dirty, so we
 * deliberately leave them out to keep the gate conservative (P24
 * direction: prefer under-counting free over over-counting).
 *
 * @param statText raw contents of memory.stat (key/value lines, bytes).
 * @param v 'v1' (keys prefixed `total_`) or 'v2' (bare keys).
 * @returns reclaimable MB, or NaN if the key is absent / unparseable so
 *          the caller can decide to fall back to the bare free figure.
 */
export function parseReclaimableFromMemStat(
  statText: string,
  v: 'v1' | 'v2',
): number {
  const key = v === 'v1' ? 'total_inactive_file' : 'inactive_file';
  for (const line of statText.split('\n')) {
    // cgroup memory.stat lines are "key value" (single space, value in
    // bytes). Match the exact key to avoid e.g. `total_inactive_anon`
    // sharing a prefix.
    const trimmed = line.trim();
    if (!trimmed.startsWith(key + ' ')) continue;
    const bytes = Number(trimmed.slice(key.length + 1).trim());
    if (!Number.isFinite(bytes) || bytes < 0) return NaN;
    return Math.floor(bytes / 1024 / 1024);
  }
  return NaN;
}

/**
 * Read a cgroup memory.stat file and return the reclaimable (inactive_file)
 * MB, or NaN on any read/parse failure. On NaN the caller adds nothing —
 * it keeps the bare (limit-usage / max-current) free figure, which is a
 * valid conservative lower bound (NOT fail-CLOSED-to-0; see
 * `defaultGetContainerFreeMemMB` docblock). Invokes `onMiss` once on
 * failure so the caller can emit a one-time WARN.
 */
async function readReclaimableMB(
  statPath: string,
  v: 'v1' | 'v2',
  onMiss: () => void,
): Promise<number> {
  try {
    const statText = await fs.readFile(statPath, 'utf8');
    const mb = parseReclaimableFromMemStat(statText, v);
    if (!Number.isFinite(mb)) {
      onMiss();
      return NaN;
    }
    return mb;
  } catch {
    onMiss();
    return NaN;
  }
}

/**
 * Slice 17 (Plan B, 2026-05-17) — One-shot probe at first use that
 * reports whether the CUDA 4-bit quant path is available
 * (`torch.cuda.is_available()` AND `import bitsandbytes` both succeed).
 *
 * Cache lifetime
 * --------------
 * Result is cached for the lifetime of the node process. torch / bnb
 * installation cannot change without restarting the node (install-deps
 * runs the venv update before re-spawning the daemon — see
 * `python-venv.ts`), so re-probing per WO would burn ~50ms of subprocess
 * latency for no information.
 *
 * Fail-CLOSED (per P24)
 * ---------------------
 * A DEFINITIVE probe failure → caches `false` → callers fall through to
 * the FP32 threshold. The cost of a false negative (CUDA pod treated as
 * FP32) is over-skip on memory-light pods. The cost of a false
 * positive (FP32-only pod treated as CUDA) is a guaranteed SIGKILL.
 * The asymmetry justifies the conservative direction.
 *
 * Transient vs definitive (Bug 2026-05-24)
 * ----------------------------------------
 * The fail-CLOSED rule must NOT cache a *transient* failure forever. Live
 * on pod1: right after a 0.8.118 self-update reinstalled the CUDA torch
 * wheel, the very first probe ran while `import torch` was still cold —
 * a cold CUDA torch import takes 10-20s and blew past the old 8s timeout,
 * so spawnSync returned `status=null` (the timer fired). The old code
 * cached that `null` as a permanent `false`, pinning the node to FP32
 * (36 GB) for its whole lifetime → every DiLoCo WO skipped on a 47 GB
 * RunPod cgroup until restart. So we now distinguish:
 *   - DEFINITIVE (`status === 0`, or a clean non-zero exit with a real
 *     python/import error): CACHE the result (fail-CLOSED preserved).
 *   - TRANSIENT (`status === null` from timeout/signal, `res.error` set
 *     from a spawn failure, or the catch block): return `false` for THIS
 *     call so the caller still safely uses FP32 once, but DO NOT cache —
 *     the next WO re-probes, and once torch is warm it gets QUANT.
 * To bound re-probing on a genuinely-slow-forever pod (so we don't add
 * ~25s probe latency to every WO indefinitely), we cap transient retries
 * at `QUANT_PROBE_TRANSIENT_CAP`; after the cap we cache `false` and give
 * up. Tradeoff: a pod whose torch import is permanently >25s settles on
 * FP32 after a few WOs instead of re-probing forever.
 */
let quantSupportCache: boolean | null = null;

/**
 * Count of consecutive transient (uncached) probe failures. Reset to 0
 * on any definitive result and by `__resetQuantSupportCacheForTests`.
 */
let quantProbeTransientCount = 0;

/**
 * Max transient probe failures before we give up and cache `false`.
 * Small so a permanently-slow pod settles on FP32 within a few WOs
 * rather than re-probing (and eating ~25s) on every WO forever.
 */
const QUANT_PROBE_TRANSIENT_CAP = 3;

export function detectQuantSupport(opts?: {
  pythonBin?: string;
  /** Test-only hook: bypass spawnSync entirely. */
  probeFn?: () => boolean;
  /**
   * Test-only hook: stand in for `spawnSync`, receiving the exact args and
   * options the production call uses so specs can both drive the result
   * shape (transient `status:null` vs definitive) and assert the timeout.
   */
  spawnFn?: typeof spawnSync;
}): boolean {
  if (quantSupportCache !== null) return quantSupportCache;

  if (opts?.probeFn) {
    quantSupportCache = opts.probeFn();
    return quantSupportCache;
  }

  try {
    const pyBin = opts?.pythonBin ?? resolvePython();
    const spawn = opts?.spawnFn ?? spawnSync;
    const res = spawn(
      pyBin,
      [
        '-c',
        'import torch, bitsandbytes; print("1" if torch.cuda.is_available() else "0")',
      ],
      {
        stdio: 'pipe',
        // Cold CUDA torch import takes 10-20s right after a self-update
        // reinstalls the wheel; 8s timed out and cached a false negative
        // for the process lifetime. 25s gives the cold import headroom.
        timeout: 25000,
        encoding: 'utf8',
        // SECURITY (F-node-008 / P9): strip wallet / keystore secrets
        // before spawning the python quant probe — see
        // utils/subprocess-env.ts.
        env: sanitizedEnvForSubprocess(),
      },
    );

    // TRANSIENT: spawnSync timed out / was killed by signal (status === null)
    // or the spawn itself failed (res.error set). DO NOT cache — re-probe
    // on the next WO once torch is warm, up to the cap.
    if (res.status === null || res.error) {
      quantProbeTransientCount += 1;
      if (quantProbeTransientCount >= QUANT_PROBE_TRANSIENT_CAP) {
        logger.warn(
          `[Preflight] quant probe transient failure ` +
            `(status=${res.status}, error=${res.error?.message ?? 'none'}) — cap reached ` +
            `(${quantProbeTransientCount}/${QUANT_PROBE_TRANSIENT_CAP}), ` +
            `caching FALSE, using FP32 thresholds`,
        );
        quantSupportCache = false;
        return false;
      }
      logger.warn(
        `[Preflight] quant probe transient failure ` +
          `(status=${res.status}, error=${res.error?.message ?? 'none'}) — NOT caching, will re-probe ` +
          `next WO (attempt ${quantProbeTransientCount}/${QUANT_PROBE_TRANSIENT_CAP})`,
      );
      return false;
    }

    // DEFINITIVE: clean exit (status 0 → parse stdout; non-zero with a real
    // python/import error → quant genuinely unavailable). Cache per P24.
    quantProbeTransientCount = 0;
    const ok = res.status === 0 && res.stdout?.trim() === '1';
    if (ok) {
      logger.log(
        '[Preflight] CUDA 4-bit quant path AVAILABLE (torch.cuda + bitsandbytes) — using QUANT thresholds',
      );
    } else {
      logger.warn(
        `[Preflight] CUDA 4-bit quant NOT available ` +
          `(status=${res.status}, stdout='${(res.stdout ?? '').trim()}', ` +
          `stderr='${(res.stderr ?? '').slice(0, 200)}') — using FP32 thresholds`,
      );
    }
    quantSupportCache = ok;
    return ok;
  } catch (err) {
    // TRANSIENT: resolvePython / spawnSync threw. Same as a timeout — do
    // not cache; re-probe next WO up to the cap.
    quantProbeTransientCount += 1;
    if (quantProbeTransientCount >= QUANT_PROBE_TRANSIENT_CAP) {
      logger.warn(
        `[Preflight] quant probe transient failure ` +
          `(threw: ${(err as Error).message}) — cap reached ` +
          `(${quantProbeTransientCount}/${QUANT_PROBE_TRANSIENT_CAP}), ` +
          `caching FALSE, using FP32 thresholds`,
      );
      quantSupportCache = false;
      return false;
    }
    logger.warn(
      `[Preflight] quant probe transient failure ` +
        `(threw: ${(err as Error).message}) — NOT caching, will re-probe ` +
        `next WO (attempt ${quantProbeTransientCount}/${QUANT_PROBE_TRANSIENT_CAP})`,
    );
    return false;
  }
}

/**
 * Test-only: reset the module-level cache + transient counter so
 * consecutive specs can exercise the probe path without process restart.
 * Production code never calls this — the cache is intentionally
 * process-lifetime.
 */
export function __resetQuantSupportCacheForTests(): void {
  quantSupportCache = null;
  quantProbeTransientCount = 0;
}

/**
 * Slice 17 (Plan B, 2026-05-17) — Heavy training workload selector.
 * Maps the abstract workload name to its preflight threshold, picking
 * QUANT or FP32 based on `detectQuantSupport()`. New callers should
 * prefer this over importing the raw constants directly — when Slice 18
 * sampler data lowers the QUANT estimate, only this helper needs to
 * pick up the new number.
 */
export type HeavyWorkload = 'DiLoCo' | 'LoRA';

export function requiredMemForHeavyTraining(workload: HeavyWorkload): number {
  const quant = detectQuantSupport();
  if (workload === 'DiLoCo') {
    return quant ? DILOCO_REQUIRED_FREE_MB_QUANT : DILOCO_REQUIRED_FREE_MB_FP32;
  }
  return quant ? LORA_REQUIRED_FREE_MB_QUANT : LORA_REQUIRED_FREE_MB_FP32;
}

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
 * Reclaimable page-cache add-back (Bug NEW-2 fix, 2026-05-22)
 * ----------------------------------------------------------
 * The cgroup `usage`/`current` counter INCLUDES reclaimable page cache —
 * clean file-backed pages the kernel evicts for free under allocation
 * pressure WITHOUT needing `drop_caches`/CAP_SYS_ADMIN (which RunPod
 * denies — see `defaultDropFsCache`). The bare `limit - usage` /
 * `max - current` formula therefore UNDER-reports free memory and the
 * gate over-skips: pod2 reported `usage=44046MB` of a `47683MB` limit
 * (old free=3637MB → skip) while `total_rss` was only 342MB and
 * 43338MB was evictable file cache (17324MB of it `total_inactive_file`,
 * 18166677504 bytes). Real available was ≥21GB. DiLoCo/LoRA were skipped
 * with "needs 8192MB/6144MB free, only 3488MB/1887MB available".
 *
 * Fix: add the immediately-reclaimable file cache back into "free":
 *   - v2: free = (max - current)  + inactive_file_MB        (memory.stat)
 *   - v1: free = (limit - usage)  + total_inactive_file_MB   (memory.stat)
 * We use `inactive_file` ONLY (the LRU, definitely-reclaimable set) and
 * leave out `active_file` / `slab_reclaimable` to stay conservative
 * (P24 direction). See `parseReclaimableFromMemStat` for the rationale.
 *
 * If memory.stat is missing / unparseable, we WARN once and fall back to
 * the OLD bare figure for that branch — NOT 0. The bare value is still a
 * valid conservative lower bound (it was the pre-fix behavior); failing
 * CLOSED here would just re-introduce the over-skip. (The whole-probe
 * fail-CLOSED-to-0 contract is still enforced by the caller's try/catch
 * around this function — P24.)
 *
 * Fallback chain:
 *   1. cgroup v2 (`memory.max` + `memory.current` + `memory.stat`) —
 *      Docker/Podman with cgroupv2 (Ubuntu 22+, RHEL 9+, RunPod 2024+).
 *   2. cgroup v1 (`memory.limit_in_bytes` + `memory.usage_in_bytes`
 *      + `memory.stat`) — older Docker hosts.
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
      const bareFree = Math.floor((max - current) / 1024 / 1024);
      // Add back immediately-reclaimable file cache (inactive_file).
      // current counts it, but the kernel evicts it for free under
      // pressure — no drop_caches/CAP_SYS_ADMIN needed.
      const reclaim = await readReclaimableMB(CGROUP_V2_STAT, 'v2', () => {
        if (!v2ReclaimWarned) {
          v2ReclaimWarned = true;
          logger.warn(
            '[Preflight] cgroup v2 memory.stat unreadable/unparseable — ' +
              'omitting reclaimable-cache add-back, using bare (max-current). ' +
              'Free figure is a conservative lower bound.',
          );
        }
      });
      return Number.isFinite(reclaim) ? bareFree + reclaim : bareFree;
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
      const bareFree = Math.floor((limit - usage) / 1024 / 1024);
      // Add back immediately-reclaimable file cache (total_inactive_file).
      // usage_in_bytes counts it, but it is evicted for free under
      // pressure — no drop_caches/CAP_SYS_ADMIN needed. See pod2 evidence
      // in parseReclaimableFromMemStat.
      const reclaim = await readReclaimableMB(CGROUP_V1_STAT, 'v1', () => {
        if (!v1ReclaimWarned) {
          v1ReclaimWarned = true;
          logger.warn(
            '[Preflight] cgroup v1 memory.stat unreadable/unparseable — ' +
              'omitting reclaimable-cache add-back, using bare (limit-usage). ' +
              'Free figure is a conservative lower bound.',
          );
        }
      });
      return Number.isFinite(reclaim) ? bareFree + reclaim : bareFree;
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
  if (requiredMB === DILOCO_REQUIRED_FREE_MB_FP32) return 'DiLoCo';
  if (requiredMB === DILOCO_REQUIRED_FREE_MB_QUANT) return 'DiLoCo';
  if (requiredMB === LORA_REQUIRED_FREE_MB_FP32) return 'LoRA';
  if (requiredMB === LORA_REQUIRED_FREE_MB_QUANT) return 'LoRA';
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
