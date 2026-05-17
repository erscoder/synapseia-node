/**
 * memory-sampler.ts — Continuous container-free + python-RSS sampler.
 *
 * Slice 10b (Plan B, 2026-05-17): the preflight gate
 * (`heavy-training-preflight.ts`) checks free memory ONCE before the
 * python spawn. After it passes the python process is opaque to the
 * node — we have no idea what the actual peak RSS / free trajectory
 * looks like. When DiLoCo gets SIGKILL'd post-preflight (live on pod
 * A40, 2026-05-17), we are reduced to guessing whether the gate
 * threshold was too low, the kernel reclaim was insufficient, or
 * something else competed for memory during the load window.
 *
 * This module starts a 500 ms ticker alongside each heavy-training
 * spawn that records:
 *   - container free MB (via the shared `defaultGetContainerFreeMemMB`
 *     used by the preflight gate, so numbers are comparable);
 *   - python process RSS MB (parsed from `/proc/<pid>/status` on
 *     Linux; silently 0 on macOS / dev laptops — `/proc` does not
 *     exist there and the heavy-training spawn does not happen on
 *     those hosts in production anyway, so missing data on dev is
 *     acceptable).
 *
 * On `stop()` a single log line summarises peaks + sample count, so
 * we can tune `DILOCO_REQUIRED_FREE_MB` / `LORA_REQUIRED_FREE_MB` to
 * the actual observed peak distribution across the fleet instead of
 * the back-of-napkin "weights + 4 GB margin" we have today.
 *
 * Design choices
 * --------------
 * - 500 ms cadence: tight enough to catch the rapid weight load
 *   curve (Qwen2.5-7B materializes in 30-90 s, so we get 60-180
 *   samples) but not so tight that the sampler itself shows up in
 *   CPU traces.
 * - Throttled per-tick log: at the cadence above we'd produce ~3600
 *   loglines for a 30-minute LoRA run. We only emit a debug line
 *   when RSS jumps by ≥1 GB from the last logged sample, so steady-
 *   state training is silent.
 * - Fail-silently on probe errors: the goal is observability, not
 *   correctness. A `/proc` read race or cgroup probe blip should
 *   NOT crash a 15-minute training run — we skip the tick and try
 *   again 500 ms later.
 * - Single-shot stop: idempotent so the caller can stop in either
 *   the `close` or `error` handler without worrying about double-
 *   logging.
 *
 * Reviewer-lessons applied
 * ------------------------
 *   P10 docblocks-match-behavior: the summary line includes the
 *     literal `freeMB peak=X min=Y; rssMB peak=Z` format so an
 *     operator scraping logs gets stable field names.
 *   P24 memory pressure signal: this module REUSES
 *     `defaultGetContainerFreeMemMB` from the preflight module,
 *     guaranteeing the sampler and the gate report numbers from the
 *     same cgroup probe. If we ever migrate the gate to a different
 *     signal the sampler follows automatically.
 */

import { promises as fs } from 'fs';
import logger from '../../utils/logger';
import { defaultGetContainerFreeMemMB } from './heavy-training-preflight';

export interface MemorySamplerHandle {
  /**
   * Stop sampling and emit the summary line. Idempotent — calling
   * twice is a no-op (the second call returns immediately without
   * a second summary).
   */
  stop: () => void;
}

export interface MemorySamplerOptions {
  /** Tick interval in ms. Defaults to 500. */
  intervalMs?: number;
  /** Override probe (test-only). */
  getFreeMemMB?: () => Promise<number>;
  /** Override RSS read (test-only). Receives pid, returns MB or 0. */
  getProcRssMB?: (pid: number) => Promise<number>;
  /**
   * Setter for the next tick. Tests substitute an immediate scheduler
   * (e.g. `setImmediate`) to drain ticks deterministically.
   */
  schedule?: (cb: () => void, ms: number) => void;
}

/**
 * Default `/proc/<pid>/status` RSS reader. Returns 0 (silently) when:
 *  - the file doesn't exist (non-Linux, or proc died);
 *  - the `VmRSS:` line is absent (some kernels for short-lived
 *    processes);
 *  - any read or parse error.
 *
 * Returning 0 instead of throwing lets the sampler keep ticking — a
 * single missed sample is preferable to a sampler crash that hides
 * the rest of the run.
 */
export async function defaultGetProcRssMB(pid: number): Promise<number> {
  try {
    const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    if (!m) return 0;
    return Math.floor(parseInt(m[1], 10) / 1024);
  } catch {
    return 0;
  }
}

/**
 * Start sampling. Returns a handle whose `stop()` ends the loop AND
 * emits a single summary log line so the caller doesn't need to
 * inspect samples directly.
 *
 * The sampler swallows all probe errors — its goal is observability,
 * not gating. Production callers wrap heavy-training spawns and call
 * `stop()` in both the `close` and `error` listeners (idempotent so
 * a double-stop is harmless).
 *
 * @param label Free-form tag included in the summary line. Typical
 *              values: "DiLoCo", "LoRA". Used to differentiate
 *              concurrent spawns in mixed-workload logs.
 * @param pythonPid The PID returned by `child_process.spawn`. Note
 *                  Node may report `undefined` if the spawn failed
 *                  before fork — callers should bail without starting
 *                  the sampler in that case (handled by the caller,
 *                  not this module, to keep the sampler signature
 *                  strict).
 */
export function startMemorySampler(
  label: string,
  pythonPid: number,
  opts: MemorySamplerOptions = {},
): MemorySamplerHandle {
  const intervalMs = opts.intervalMs ?? 500;
  const getFreeMemMB = opts.getFreeMemMB ?? defaultGetContainerFreeMemMB;
  const getProcRssMB = opts.getProcRssMB ?? defaultGetProcRssMB;
  const schedule =
    opts.schedule ?? ((cb: () => void, ms: number) => { setTimeout(cb, ms); });

  let stopped = false;
  let sampleCount = 0;
  let peakFree: number | null = null;
  let minFree: number | null = null;
  let peakRss = 0;
  // Throttle the per-tick debug log: emit a `mem` line only when RSS
  // jumped at least LOG_RSS_DELTA_MB from the last logged value, so a
  // 30-minute steady-state run doesn't produce ~3600 loglines.
  const LOG_RSS_DELTA_MB = 1024;
  let lastLoggedRss = -LOG_RSS_DELTA_MB; // force the first sample to log

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const freeMB = await getFreeMemMB();
      const rssMB = await getProcRssMB(pythonPid);
      sampleCount += 1;
      peakFree = peakFree === null ? freeMB : Math.max(peakFree, freeMB);
      minFree = minFree === null ? freeMB : Math.min(minFree, freeMB);
      if (rssMB > peakRss) peakRss = rssMB;
      if (Math.abs(rssMB - lastLoggedRss) >= LOG_RSS_DELTA_MB) {
        logger.log(
          `[MemSampler ${label}] pid=${pythonPid} freeMB=${freeMB} rssMB=${rssMB}`,
        );
        lastLoggedRss = rssMB;
      }
    } catch {
      // Probe failed — skip this tick, keep sampling.
    }
    if (!stopped) {
      schedule(() => { void tick(); }, intervalMs);
    }
  };

  // Kick off the first tick immediately (no initial wait so we capture
  // the pre-load baseline). Errors inside `tick()` are swallowed; the
  // promise itself can't throw.
  void tick();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      logger.log(
        `[MemSampler ${label}] pid=${pythonPid} samples=${sampleCount} ` +
          `freeMB peak=${peakFree ?? 'n/a'} min=${minFree ?? 'n/a'}; ` +
          `rssMB peak=${peakRss}`,
      );
    },
  };
}
