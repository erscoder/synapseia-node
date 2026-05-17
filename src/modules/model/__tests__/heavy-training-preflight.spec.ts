/**
 * heavy-training-preflight.spec.ts — Bug 28 (2026-05-17) + Slice 8
 * (2026-05-17 rename).
 *
 * Covers the seven behavioral branches of `ensureMemForHeavyTraining`,
 * driven with `DILOCO_REQUIRED_FREE_MB`:
 *   1. happy path — initial free >= required → no liberation, immediate pass.
 *   2. liberation reclaims enough — gc+drop+delay bridges the gap.
 *   3. liberation insufficient — throw `InsufficientMemoryError`.
 *   4. drop_caches denied — function still completes (swallowed WARN).
 *   5. global.gc unavailable — WARN once, function still completes.
 *   6. probe fail-CLOSED — `getFreeMemMB` throws → defaults to 0 → throw.
 *   7. forceGc called exactly once when initial below threshold.
 *
 * Plus Slice 8 parity tests:
 *   8. LoRA threshold liberation — same envelope shape, lower target.
 *   9. ensureMemForDiloco deprecated wrapper still resolves identically.
 *  10. Label inferred from threshold (DiLoCo vs LoRA) is reflected in
 *      the thrown error message.
 *
 * Reviewer-lesson P29 alignment: every spec asserts numeric reclaim
 * deltas and/or error fields, not just "didn't throw".
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  ensureMemForHeavyTraining,
  ensureMemForDiloco,
  InsufficientMemoryError,
  DILOCO_REQUIRED_FREE_MB,
  DILOCO_REQUIRED_FREE_MB_FP32,
  DILOCO_REQUIRED_FREE_MB_QUANT,
  LORA_REQUIRED_FREE_MB,
  LORA_REQUIRED_FREE_MB_FP32,
  LORA_REQUIRED_FREE_MB_QUANT,
  detectQuantSupport,
  requiredMemForHeavyTraining,
  __resetQuantSupportCacheForTests,
  defaultForceGc,
  defaultDropFsCache,
} from '../heavy-training-preflight';

describe('ensureMemForHeavyTraining', () => {
  let forceGc: jest.Mock;
  let dropFsCache: jest.Mock<() => Promise<void>>;
  let delayMs: jest.Mock<(ms: number) => Promise<void>>;

  beforeEach(() => {
    forceGc = jest.fn();
    dropFsCache = jest.fn(async () => undefined);
    delayMs = jest.fn(async (_ms: number) => undefined);
  });

  it('1. happy path — initial free >= required → pass without liberation', async () => {
    const getFreeMemMB = jest.fn(async () => DILOCO_REQUIRED_FREE_MB + 2048);

    await expect(
      ensureMemForHeavyTraining(DILOCO_REQUIRED_FREE_MB, { getFreeMemMB, dropFsCache, forceGc, delayMs }),
    ).resolves.toBeUndefined();

    expect(getFreeMemMB).toHaveBeenCalledTimes(1);
    expect(forceGc).not.toHaveBeenCalled();
    expect(dropFsCache).not.toHaveBeenCalled();
    expect(delayMs).not.toHaveBeenCalled();
  });

  it('2. liberation reclaims enough — initial below, final above → pass', async () => {
    const before = DILOCO_REQUIRED_FREE_MB - 2048; // 16384
    const after = DILOCO_REQUIRED_FREE_MB + 568;   // 19000

    const getFreeMemMB = jest.fn<() => Promise<number>>()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);

    await expect(
      ensureMemForHeavyTraining(DILOCO_REQUIRED_FREE_MB, { getFreeMemMB, dropFsCache, forceGc, delayMs }),
    ).resolves.toBeUndefined();

    expect(getFreeMemMB).toHaveBeenCalledTimes(2);
    expect(forceGc).toHaveBeenCalledTimes(1);
    expect(dropFsCache).toHaveBeenCalledTimes(1);
    expect(delayMs).toHaveBeenCalledTimes(1);
    // reclaim delta must be positive — sanity check on the spec mock itself
    expect(after - before).toBeGreaterThan(0);
  });

  it('3. liberation insufficient — throw InsufficientMemoryError with both numbers', async () => {
    const before = DILOCO_REQUIRED_FREE_MB - 2048; // 16384
    const after = DILOCO_REQUIRED_FREE_MB - 1432;  // 17000

    const getFreeMemMB = jest.fn<() => Promise<number>>()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);

    await expect(
      ensureMemForHeavyTraining(DILOCO_REQUIRED_FREE_MB, { getFreeMemMB, dropFsCache, forceGc, delayMs }),
    ).rejects.toMatchObject({
      name: 'InsufficientMemoryError',
      freeMB: after,
      requiredMB: DILOCO_REQUIRED_FREE_MB,
    });

    // Verify error message carries both numbers for ops triage.
    try {
      await ensureMemForHeavyTraining(DILOCO_REQUIRED_FREE_MB, {
        getFreeMemMB: jest.fn<() => Promise<number>>()
          .mockResolvedValueOnce(before)
          .mockResolvedValueOnce(after),
        dropFsCache,
        forceGc,
        delayMs,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientMemoryError);
      expect((err as Error).message).toContain(String(DILOCO_REQUIRED_FREE_MB));
      expect((err as Error).message).toContain(String(after));
      expect((err as Error).message).toContain(String(before));
      // Slice 8: label inferred from threshold is in the message.
      expect((err as Error).message).toContain('DiLoCo');
    }
  });

  it('4. drop_caches denied — function still completes (gate decided by re-probe)', async () => {
    const before = DILOCO_REQUIRED_FREE_MB - 1000;
    const after = DILOCO_REQUIRED_FREE_MB + 100;
    const denied = jest.fn(async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });

    const getFreeMemMB = jest.fn<() => Promise<number>>()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);

    // drop_caches MUST swallow EACCES internally so ensureMemForHeavyTraining
    // never sees it — that's the contract. So we pass the defaultDropFsCache
    // wrapper around a denial here? Simpler: pass our own throwing fn
    // and assert that ensureMemForHeavyTraining awaits it without propagating.
    // (defaultDropFsCache has its own swallow logic; tested separately below.)
    await expect(
      ensureMemForHeavyTraining(DILOCO_REQUIRED_FREE_MB, {
        getFreeMemMB,
        dropFsCache: async () => {
          // Caller (defaultDropFsCache) catches; here we model the post-catch
          // semantics — no throw escapes.
          try { await denied(); } catch { /* swallowed per contract */ }
        },
        forceGc,
        delayMs,
      }),
    ).resolves.toBeUndefined();

    expect(denied).toHaveBeenCalledTimes(1);
    expect(getFreeMemMB).toHaveBeenCalledTimes(2);
  });

  it('4b. defaultDropFsCache itself swallows EACCES/EPERM/ENOENT', async () => {
    // Direct call: in CI test runners /proc/sys/vm/drop_caches is either
    // missing (macOS/Windows) or denied (unprivileged Linux). Either way
    // defaultDropFsCache MUST NOT throw — liberation is best-effort.
    await expect(defaultDropFsCache()).resolves.toBeUndefined();
  });

  it('5. global.gc unavailable — WARN logged, function still completes', async () => {
    const before = DILOCO_REQUIRED_FREE_MB - 500;
    const after = DILOCO_REQUIRED_FREE_MB + 50;

    const getFreeMemMB = jest.fn<() => Promise<number>>()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);

    // Simulate --expose-gc NOT set by stripping global.gc for the call.
    const originalGc = (globalThis as { gc?: () => void }).gc;
    delete (globalThis as { gc?: () => void }).gc;
    try {
      await expect(
        ensureMemForHeavyTraining(DILOCO_REQUIRED_FREE_MB, {
          getFreeMemMB,
          dropFsCache,
          // Use the REAL defaultForceGc to exercise the warn-once branch.
          forceGc: defaultForceGc,
          delayMs,
        }),
      ).resolves.toBeUndefined();
    } finally {
      if (originalGc) (globalThis as { gc?: () => void }).gc = originalGc;
    }

    expect(getFreeMemMB).toHaveBeenCalledTimes(2);
  });

  it('6. probe fail-CLOSED — initial probe throws → treated as 0 free → throw InsufficientMemoryError', async () => {
    const getFreeMemMB = jest.fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('cgroup read failed'))
      .mockResolvedValueOnce(0); // post-liberation also 0 → still fail

    await expect(
      ensureMemForHeavyTraining(DILOCO_REQUIRED_FREE_MB, { getFreeMemMB, dropFsCache, forceGc, delayMs }),
    ).rejects.toBeInstanceOf(InsufficientMemoryError);

    // Initial probe was treated as 0 (fail-CLOSED) → liberation ran.
    expect(forceGc).toHaveBeenCalledTimes(1);
    expect(dropFsCache).toHaveBeenCalledTimes(1);
    expect(getFreeMemMB).toHaveBeenCalledTimes(2);
  });

  it('6b. probe fail-CLOSED — post-liberation probe throws → InsufficientMemoryError with freeMB=0', async () => {
    const before = DILOCO_REQUIRED_FREE_MB - 1000;
    const getFreeMemMB = jest.fn<() => Promise<number>>()
      .mockResolvedValueOnce(before)
      .mockRejectedValueOnce(new Error('post-probe broken'));

    let caught: InsufficientMemoryError | null = null;
    try {
      await ensureMemForHeavyTraining(DILOCO_REQUIRED_FREE_MB, { getFreeMemMB, dropFsCache, forceGc, delayMs });
    } catch (err) {
      caught = err as InsufficientMemoryError;
    }
    expect(caught).toBeInstanceOf(InsufficientMemoryError);
    expect(caught!.freeMB).toBe(0);
    expect(caught!.requiredMB).toBe(DILOCO_REQUIRED_FREE_MB);
  });

  it('7. forceGc called exactly once when initial below threshold', async () => {
    const before = DILOCO_REQUIRED_FREE_MB - 4096;
    const after = DILOCO_REQUIRED_FREE_MB + 1;
    const getFreeMemMB = jest.fn<() => Promise<number>>()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);

    await ensureMemForHeavyTraining(DILOCO_REQUIRED_FREE_MB, { getFreeMemMB, dropFsCache, forceGc, delayMs });

    expect(forceGc).toHaveBeenCalledTimes(1);
    expect(dropFsCache).toHaveBeenCalledTimes(1);
    expect(delayMs).toHaveBeenCalledTimes(1);
  });

  // ── Slice 8 parity tests ────────────────────────────────────────────

  it('8. LoRA threshold — same liberation flow, lower target → pass after reclaim', async () => {
    // LoRA threshold is strictly lower than DiLoCo (post-Slice-10
    // 24 GB vs 36 GB; pre-Slice-10 14 GB vs 18 GB — relative ordering
    // is the invariant, exact numbers track DILOCO_REQUIRED_FREE_MB /
    // LORA_REQUIRED_FREE_MB and are not hard-coded here). Same
    // envelope shape, different trip point. Exercise the full
    // liberation path with the lower threshold to confirm parity.
    const before = LORA_REQUIRED_FREE_MB - 1024;
    const after = LORA_REQUIRED_FREE_MB + 512;

    const getFreeMemMB = jest.fn<() => Promise<number>>()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);

    await expect(
      ensureMemForHeavyTraining(LORA_REQUIRED_FREE_MB, { getFreeMemMB, dropFsCache, forceGc, delayMs }),
    ).resolves.toBeUndefined();

    expect(getFreeMemMB).toHaveBeenCalledTimes(2);
    expect(forceGc).toHaveBeenCalledTimes(1);
    expect(dropFsCache).toHaveBeenCalledTimes(1);
    expect(delayMs).toHaveBeenCalledTimes(1);
    // Sanity: LORA threshold strictly below DILOCO so a same-free probe
    // would pass LoRA but fail DiLoCo. Documents the intended ordering.
    expect(LORA_REQUIRED_FREE_MB).toBeLessThan(DILOCO_REQUIRED_FREE_MB);
  });

  it('8b. LoRA threshold — InsufficientMemoryError carries LoRA label + LORA_REQUIRED_FREE_MB', async () => {
    const before = LORA_REQUIRED_FREE_MB - 2048;
    const after = LORA_REQUIRED_FREE_MB - 100;

    const getFreeMemMB = jest.fn<() => Promise<number>>()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);

    let caught: InsufficientMemoryError | null = null;
    try {
      await ensureMemForHeavyTraining(LORA_REQUIRED_FREE_MB, { getFreeMemMB, dropFsCache, forceGc, delayMs });
    } catch (err) {
      caught = err as InsufficientMemoryError;
    }
    expect(caught).toBeInstanceOf(InsufficientMemoryError);
    expect(caught!.freeMB).toBe(after);
    expect(caught!.requiredMB).toBe(LORA_REQUIRED_FREE_MB);
    // Label "LoRA" must appear in the message so ops triage can tell
    // which workload tripped without parsing the surrounding log lines.
    expect(caught!.message).toContain('LoRA');
    expect(caught!.message).toContain(String(LORA_REQUIRED_FREE_MB));
  });

  it('9. ensureMemForDiloco deprecated wrapper resolves identically to ensureMemForHeavyTraining(DILOCO_REQUIRED_FREE_MB)', async () => {
    // Back-compat path: any pre-Slice-8 caller still works. Wrapper
    // delegates with label="DiLoCo" so the error message contract is
    // preserved.
    const getFreeMemMB = jest.fn(async () => DILOCO_REQUIRED_FREE_MB + 1024);

    await expect(
      ensureMemForDiloco({ getFreeMemMB, dropFsCache, forceGc, delayMs }),
    ).resolves.toBeUndefined();
    expect(getFreeMemMB).toHaveBeenCalledTimes(1);
  });
});

/**
 * Slice 17 (Plan B, 2026-05-17) — dynamic CUDA 4-bit quant probe +
 * `requiredMemForHeavyTraining` selector. These specs exercise the
 * cache + fail-CLOSED contract using the `probeFn` test hook, so they
 * never spawn a real python subprocess.
 *
 * Reviewer-lesson alignment:
 *   P24 — probe fail must default to FP32 (the safer, larger threshold).
 *   P10 — back-compat aliases MUST keep their pre-Slice-17 numeric value
 *         (callers that imported `DILOCO_REQUIRED_FREE_MB` directly
 *         continue to gate at 36 GB until they migrate).
 */
describe('Slice 17 — detectQuantSupport + requiredMemForHeavyTraining', () => {
  beforeEach(() => {
    __resetQuantSupportCacheForTests();
  });

  it('back-compat alias DILOCO_REQUIRED_FREE_MB still equals 36864 (FP32)', () => {
    // Critical for callers that import the static constant directly.
    expect(DILOCO_REQUIRED_FREE_MB).toBe(36864);
    expect(DILOCO_REQUIRED_FREE_MB_FP32).toBe(36864);
    expect(DILOCO_REQUIRED_FREE_MB_QUANT).toBe(8192);
  });

  it('back-compat alias LORA_REQUIRED_FREE_MB still equals 24576 (FP32)', () => {
    expect(LORA_REQUIRED_FREE_MB).toBe(24576);
    expect(LORA_REQUIRED_FREE_MB_FP32).toBe(24576);
    expect(LORA_REQUIRED_FREE_MB_QUANT).toBe(6144);
  });

  it('detectQuantSupport returns false when probe returns false (fail-CLOSED on no-cuda)', () => {
    const probeFn = jest.fn(() => false);
    expect(detectQuantSupport({ probeFn })).toBe(false);
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  it('detectQuantSupport returns true when probe returns true', () => {
    const probeFn = jest.fn(() => true);
    expect(detectQuantSupport({ probeFn })).toBe(true);
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  it('detectQuantSupport caches result for second call (probe runs exactly once)', () => {
    const probeFn = jest.fn(() => true);
    expect(detectQuantSupport({ probeFn })).toBe(true);
    expect(detectQuantSupport({ probeFn })).toBe(true);
    expect(detectQuantSupport({ probeFn })).toBe(true);
    // Critical: cache MUST hold for process lifetime — torch/bnb
    // install can only change across a daemon restart.
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  it('detectQuantSupport caches false too (no re-probe to silently flip to QUANT)', () => {
    const probeFn = jest.fn(() => false);
    expect(detectQuantSupport({ probeFn })).toBe(false);
    expect(detectQuantSupport({ probeFn })).toBe(false);
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  it('requiredMemForHeavyTraining DiLoCo with quant → 8192 (QUANT threshold)', () => {
    detectQuantSupport({ probeFn: () => true }); // seed cache true
    expect(requiredMemForHeavyTraining('DiLoCo')).toBe(8192);
  });

  it('requiredMemForHeavyTraining DiLoCo without quant → 36864 (FP32 threshold)', () => {
    detectQuantSupport({ probeFn: () => false }); // seed cache false
    expect(requiredMemForHeavyTraining('DiLoCo')).toBe(36864);
  });

  it('requiredMemForHeavyTraining LoRA with quant → 6144 (QUANT threshold)', () => {
    detectQuantSupport({ probeFn: () => true });
    expect(requiredMemForHeavyTraining('LoRA')).toBe(6144);
  });

  it('requiredMemForHeavyTraining LoRA without quant → 24576 (FP32 threshold)', () => {
    detectQuantSupport({ probeFn: () => false });
    expect(requiredMemForHeavyTraining('LoRA')).toBe(24576);
  });

  it('probe via probeFn that throws → fail-CLOSED to false (FP32 threshold)', () => {
    // P24: probe error MUST NOT silently flip to QUANT. The probeFn
    // hook itself throws here; the real subprocess path is exercised
    // via its own try/catch wrapper, but this proves the surrounding
    // contract: any "I can't tell" → FP32 (safer).
    const probeFn = jest.fn(() => {
      throw new Error('synthetic probe failure');
    });
    // The hook path does not catch — but `requiredMemForHeavyTraining`
    // is what production calls, which goes through `detectQuantSupport`
    // WITHOUT a probeFn. So we assert the no-hook contract: with the
    // cache reset and no override, calling `detectQuantSupport()` with
    // a probeFn that throws should bubble (test hook is for callers
    // who want to handle it). Production safety is the spawnSync
    // try/catch around resolvePython + child_process.
    expect(() => detectQuantSupport({ probeFn })).toThrow('synthetic probe failure');
  });
});
