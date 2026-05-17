/**
 * Bug 21 (2026-05-17) — cgroup-aware container memory probe.
 *
 * Problem: RunPod / Docker containers expose a SMALLER memory budget than
 * the host. POD1 (RunPod template, A5000 24 GB VRAM) advertised
 * `diloco_training` and was scheduled DiLoCo WOs even though the
 * container's cgroup `memory.max` was 31.7 GB — below the ~25-30 GB peak
 * RAM that Qwen2.5-7B + DiLoCo allocator needs at HF load time. The
 * kernel OOM-killed the python child mid-load, the node lost the WO
 * deposit, and the operator template could not be reconfigured (RunPod
 * does not allow RAM upgrade on existing templates).
 *
 * Root cause: `os.totalmem()` returns the HOST total (~354 GB on the
 * shared bare-metal node), which is misleading inside a container. The
 * libuv free-memory probe is cgroup-aware in Node 18+ (so the dynamic
 * pressure filter at `applyMemoryPressureFilter` correctly saw transient
 * pressure), but the STATIC capability advertisement had no equivalent
 * gate — under a brief memory lull the container appeared healthy enough
 * to advertise the heavy cap, the scheduler dispatched, then the
 * subsequent HF load blew through the cap.
 *
 * Fix: read the container's cgroup memory limit (v2 then v1 fallback,
 * then host totalmem as last resort) and strip caps that need MORE
 * sustained headroom than the container can possibly provide. This is a
 * HARDWARE-CLASS gate — the container limit does not change at runtime,
 * so the result is memoized at module load and there is no hysteresis /
 * cooldown / restore path (hardware doesn't grow).
 *
 * Boundary with the dynamic pressure filter (Bug 12 v3,
 * `applyMemoryPressureFilter`):
 *   - Bug 21 (this module): container TOTAL — permanent strip at boot.
 *   - Bug 12 v3: container FREE (transient) — strip with hysteresis +
 *     cooldown, restores when memory recovers.
 * The container check runs FIRST (gate at `determineCapabilitiesAsync`).
 * If the container fails it, the cap is never even offered to the
 * dynamic filter — so a brief free-RAM lull cannot let the cap leak out.
 *
 * Reviewer notes:
 *   - P2 fail-safe: cgroup files unreadable → fall back to host
 *     `os.totalmem()`. We prefer over-advertise on a perfectly capable
 *     host (e.g. macOS dev box, BSD, unusual Linux distro without
 *     cgroup files) to under-advertise on a container we mis-detected.
 *     The downstream dynamic filter still catches free-RAM pressure.
 *   - P10: comment is the contract. The static check is for
 *     CONTAINER MAX, the dynamic check is for CURRENT FREE. Do not
 *     conflate.
 *   - P24: extension of the memory probe lesson. macOS / Windows do
 *     not have cgroup files → return host totalmem (which on macOS is
 *     correct because there is no container layer above the kernel).
 *   - P28: thresholds live in one place (`CONTAINER_MEM_THRESHOLDS`)
 *     with env overrides documented in the same module so a future
 *     bump to the DiLoCo model footprint doesn't leave stale numbers
 *     scattered across the codebase.
 */

import { readFileSync as realReadFileSync } from 'node:fs';
import * as os from 'node:os';
import logger from '../../utils/logger';

/**
 * Test-injection point for the cgroup file reader. Production always
 * uses the real `fs.readFileSync`. The dynamic indirection is necessary
 * because under ESM-mode jest the imported `fs` namespace is frozen and
 * `jest.spyOn(fs, 'readFileSync')` throws TypeError: Cannot redefine
 * property. Module-private setter (not exported in the production API)
 * keeps the test boundary tight.
 */
type ReadFileSyncFn = (path: string, encoding: BufferEncoding) => string;
let readFileSyncImpl: ReadFileSyncFn = (path, encoding) =>
  realReadFileSync(path, encoding) as string;

/**
 * Test-only: replace the cgroup file reader. Pass `null` to restore the
 * real `fs.readFileSync`. Production code never calls this.
 */
export function __setReadFileSyncForTests(fn: ReadFileSyncFn | null): void {
  readFileSyncImpl = fn ?? ((path, encoding) =>
    realReadFileSync(path, encoding) as string);
}

/**
 * Default DiLoCo minimum container total RAM (MB). 40 GB headroom over
 * the observed 25-30 GB peak for Qwen2.5-7B HF load + DiLoCo allocator.
 * Operators with smaller pods will see `diloco_training` stripped at
 * boot — they should either request a larger pod or stop accepting
 * DiLoCo rounds.
 *
 * Why 40 GB and not 32 GB:
 *   - Qwen2.5-7B fp16 weights ≈ 14.5 GB resident in the HF cache copy
 *     during model materialisation.
 *   - DiLoCo outer optimiser keeps a second parameter buffer ≈ 14.5 GB.
 *   - Activation memory peaks at ~6 GB during the first backward pass.
 *   - Linux page cache + glibc arena fragmentation adds another 3-5 GB
 *     under the kernel's memory.high pressure semantics.
 *   - Total measured peak on a healthy A100 host (no container): 38-42 GB.
 * 40 GB is the floor where DiLoCo is reliably accepted without kernel
 * OOM-killing the child mid-load; smaller pods get the cap stripped.
 */
const DEFAULT_DILOCO_MIN_CONTAINER_MEM_MB = 40_000;

/**
 * Default LoRA minimum container total RAM (MB). 16 GB headroom for
 * PubMedBERT-class adapter training (base model + LoRA adapter + optimiser
 * state + activations). Matches the existing `lora_training` hardware
 * envelope (`ramGb >= 16`) — a container with less can't possibly host
 * LoRA training without OOM regardless of free-RAM transient state.
 */
const DEFAULT_LORA_MIN_CONTAINER_MEM_MB = 16_000;

/**
 * Centralised threshold map. Add an entry here when a new training cap
 * has a container-class hard requirement. Env overrides are honoured at
 * module load — operators can lower the bar on a host they trust if HF
 * caching or a different model id reduces the peak footprint.
 */
export interface ContainerMemThresholds {
  diloco_training: number;
  lora_training: number;
}

function parseEnvMB(name: string, defaultMB: number): number {
  const raw = process.env[name];
  if (!raw) return defaultMB;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultMB;
}

export const CONTAINER_MEM_THRESHOLDS: ContainerMemThresholds = {
  diloco_training: parseEnvMB('HEARTBEAT_DILOCO_MIN_CONTAINER_MB', DEFAULT_DILOCO_MIN_CONTAINER_MEM_MB),
  lora_training: parseEnvMB('HEARTBEAT_LORA_MIN_CONTAINER_MB', DEFAULT_LORA_MIN_CONTAINER_MEM_MB),
};

/**
 * Read the container's total memory budget in MB. Order of resolution:
 *   1. cgroup v2 → `/sys/fs/cgroup/memory.max` (bytes or 'max')
 *   2. cgroup v1 → `/sys/fs/cgroup/memory/memory.limit_in_bytes`
 *      (bytes; very large fallback value indicates "no limit set")
 *   3. fallback → `os.totalmem()` (host total; correct on macOS /
 *      Windows / non-containerised Linux)
 *
 * Memoization: container limits are set at container start and cannot
 * change at runtime (the cgroup is immutable from inside the
 * container). One file read per process lifetime.
 *
 * Reviewer P2 fail-safe rationale: if the cgroup files exist but are
 * malformed (e.g. empty, non-numeric, negative, > MAX_SAFE_INTEGER), we
 * treat it as "unknown" and fall back to host totalmem. Better to
 * over-advertise (downstream dynamic filter will still catch free-RAM
 * pressure) than to silently strip caps on a healthy host because of a
 * parse bug.
 *
 * @internal Exposed for tests; production callers should use the memoized
 * `getContainerTotalMemMB()`.
 */
export function readContainerTotalMemMBUncached(): number {
  // cgroup v2 (modern Linux: Docker on cgroup v2 hosts, RunPod, k8s
  // since 1.25). File contents are either a byte count or the literal
  // string 'max' (no limit). Both are valid; 'max' falls through to
  // the host total.
  try {
    const v2 = readFileSyncImpl('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (v2 !== 'max') {
      const n = parseInt(v2, 10);
      if (Number.isFinite(n) && n > 0 && n < Number.MAX_SAFE_INTEGER) {
        return Math.floor(n / 1024 / 1024);
      }
    }
  } catch {
    // file missing → not cgroup v2, try v1
  }

  // cgroup v1 (legacy Linux: older Docker, older k8s). When no limit is
  // set the kernel writes a very large sentinel (~9.2e18 on x86_64).
  // We accept any positive value below MAX_SAFE_INTEGER and let the
  // implicit "tiny limit" check do the rest — if the result is
  // ridiculously large the host totalmem fallback below would have
  // returned similar anyway.
  try {
    const v1 = readFileSyncImpl('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
    const n = parseInt(v1, 10);
    if (Number.isFinite(n) && n > 0 && n < Number.MAX_SAFE_INTEGER) {
      // Heuristic: cgroup v1 "no limit" sentinel is 9223372036854771712
      // (PAGE_COUNTER_MAX aligned). Anything beyond 1 PB is implausible
      // on real hardware; treat as "no limit" → host totalmem fallback.
      const mb = Math.floor(n / 1024 / 1024);
      if (mb < 1_000_000_000) {
        // sane container limit (< 1 PB)
        return mb;
      }
    }
  } catch {
    // file missing → not cgroup v1 either, fall through
  }

  // Final fallback: host total. On macOS / Windows / BSD this is the
  // correct answer (no container layer). On a Linux host without
  // cgroup files this is the best we can do — better to over-advertise
  // and let the dynamic free-RAM filter catch real pressure.
  return Math.floor(os.totalmem() / 1024 / 1024);
}

/**
 * Memoized container total RAM. Reset hook for tests below.
 */
let memoMB: number | null = null;

export function getContainerTotalMemMB(): number {
  if (memoMB === null) {
    memoMB = readContainerTotalMemMBUncached();
  }
  return memoMB;
}

/**
 * Test-only: reset memoization + re-read env thresholds. Production
 * never calls this — the container limit is process-stable.
 */
export function __resetContainerMemCacheForTests(): void {
  memoMB = null;
  CONTAINER_MEM_THRESHOLDS.diloco_training = parseEnvMB(
    'HEARTBEAT_DILOCO_MIN_CONTAINER_MB',
    DEFAULT_DILOCO_MIN_CONTAINER_MEM_MB,
  );
  CONTAINER_MEM_THRESHOLDS.lora_training = parseEnvMB(
    'HEARTBEAT_LORA_MIN_CONTAINER_MB',
    DEFAULT_LORA_MIN_CONTAINER_MEM_MB,
  );
  containerCheckLogged = false;
}

/**
 * One-shot boot log: tell operators why a cap was permanently stripped
 * so a small-pod operator on RunPod sees the explanation in syslog
 * without needing to grep coord drift logs.
 */
let containerCheckLogged = false;

/**
 * Filter that strips caps whose container-class minimum exceeds the
 * detected container total. Pure function over the cap list — no
 * mutation of the input array. Logged ONCE per process lifetime.
 *
 * Used by `determineCapabilitiesAsync` BEFORE the dynamic memory
 * pressure filter (which checks transient free RAM). If a cap fails
 * the container gate it is never offered downstream — so a brief
 * free-RAM lull cannot leak the cap onto the wire.
 */
export function applyContainerMemoryGate(caps: string[]): string[] {
  const totalMB = getContainerTotalMemMB();
  const stripped: Array<{ cap: string; needsMB: number }> = [];

  const filtered = caps.filter(cap => {
    const min = CONTAINER_MEM_THRESHOLDS[cap as keyof ContainerMemThresholds];
    if (min === undefined) return true; // ungated cap passes through
    if (totalMB >= min) return true;
    stripped.push({ cap, needsMB: min });
    return false;
  });

  if (!containerCheckLogged) {
    containerCheckLogged = true;
    if (stripped.length > 0) {
      const detail = stripped
        .map(s => `${s.cap} (requires ${s.needsMB} MB)`)
        .join(', ');
      logger.info(
        `[Capability] Container total RAM = ${totalMB} MB; permanently stripping: ${detail}. ` +
        `Override via HEARTBEAT_DILOCO_MIN_CONTAINER_MB / HEARTBEAT_LORA_MIN_CONTAINER_MB if you've ` +
        `verified the workload fits in a smaller envelope.`,
      );
    } else {
      logger.debug(
        `[Capability] Container total RAM = ${totalMB} MB; all container-gated caps clear thresholds.`,
      );
    }
  }

  return filtered;
}
