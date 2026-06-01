/**
 * Bug 21 — cgroup-aware container memory probe.
 *
 * Live evidence (2026-05-17): POD1 (RunPod template, A5000 24 GB VRAM)
 * advertised `diloco_training` despite its cgroup `memory.max` being
 * 31.7 GB — below the ~25-30 GB peak that Qwen2.5-7B + DiLoCo needs
 * during HF load. Scheduler dispatched a DiLoCo round, python child
 * OOM-killed mid-load, deposit lost. RunPod does not allow RAM upgrade
 * on existing templates so the only fix is the node not advertising
 * the cap in the first place.
 *
 * Contract under test:
 *   1. cgroup v2 (`/sys/fs/cgroup/memory.max`) numeric → parsed to MB.
 *   2. cgroup v2 sentinel `'max'` → fall through to host totalmem.
 *   3. cgroup v1 (`/sys/fs/cgroup/memory/memory.limit_in_bytes`) → parsed.
 *   4. Both files missing → host `os.totalmem()` fallback.
 *   5. Container below DiLoCo threshold → `diloco_training` stripped
 *      in `determineCapabilitiesAsync`.
 *   6. Container above DiLoCo threshold → `diloco_training` kept
 *      (assuming downstream probes pass).
 *   7. Container below LoRA threshold → `lora_training` stripped.
 *   8. Env override `HEARTBEAT_DILOCO_MIN_CONTAINER_MB` lowers the bar.
 *   9. Memoization: subsequent calls do NOT re-read the cgroup file.
 *  10. P2 fail-safe: malformed cgroup contents → fall back to host total.
 */

import { describe, it, expect, jest, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import * as os from 'node:os';
import logger from '../../../utils/logger';
import {
  HeartbeatHelper,
  __resetCapabilitySnapshotForTests,
  __seedLoraStackProbeForTests,
  __seedDilocoModelProbeForTests,
  __seedCudaCacheForTests,
} from '../heartbeat';
import {
  readContainerTotalMemMBUncached,
  getContainerTotalMemMB,
  applyContainerMemoryGate,
  CONTAINER_MEM_THRESHOLDS,
  __resetContainerMemCacheForTests,
  __setReadFileSyncForTests,
} from '../container-mem';
import type { Hardware } from '../../hardware/hardware';

// Mock the docking module so unrelated Vina probe doesn't spawn brew/which.
jest.mock('../../docking', () => ({
  isVinaAvailable: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
  __resetVinaCacheForTests: jest.fn(),
  runDocking: jest.fn(),
  assertBinariesAvailable: jest.fn(),
  parseVinaPdbqt: jest.fn(),
  DockingError: class DockingError extends Error {},
}));

// PyTorch + LLM probes return true so cpu_training stays in the cap set.
jest.mock('../../model/trainer', () => {
  const actual = jest.requireActual<typeof import('../../model/trainer')>(
    '../../model/trainer',
  );
  return {
    ...actual,
    isPyTorchAvailable: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
});

jest.mock('../../llm/training-llm', () => ({
  resolveTrainingLlmModel: jest
    .fn<() => Promise<string | null>>()
    .mockResolvedValue('llama3.2:1b'),
}));

const POD_HARDWARE: Hardware = {
  arch: 'x64' as any,
  cpuCores: 16,
  ramGb: 32,
  gpuVramGb: 24,
  hasOllama: true,
  hasCloudLlm: false,
  hardwareClass: 4,
} as Hardware;

/**
 * Track of cgroup file reads observed by the mock — used by the
 * memoization test to assert the cache prevented re-reads.
 */
const cgroupReads: string[] = [];

/**
 * Install a mock readFileSync via the container-mem module's test
 * injection point. Production-mode code paths in unrelated modules
 * still hit the real `fs.readFileSync` because we don't touch the
 * `fs` namespace itself — only the indirection inside `container-mem.ts`
 * is rerouted.
 */
function mockCgroup(opts: { v2?: string | null; v1?: string | null }): void {
  __setReadFileSyncForTests((path: string) => {
    cgroupReads.push(path);
    if (path === '/sys/fs/cgroup/memory.max') {
      if (opts.v2 === null || opts.v2 === undefined) {
        const e: any = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return opts.v2;
    }
    if (path === '/sys/fs/cgroup/memory/memory.limit_in_bytes') {
      if (opts.v1 === null || opts.v1 === undefined) {
        const e: any = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return opts.v1;
    }
    const e: any = new Error(`ENOENT (mock): ${path}`);
    e.code = 'ENOENT';
    throw e;
  });
}

function restoreCgroup(): void {
  __setReadFileSyncForTests(null);
  cgroupReads.length = 0;
}

describe('container-mem — readContainerTotalMemMBUncached()', () => {
  beforeEach(() => {
    __resetContainerMemCacheForTests();
    cgroupReads.length = 0;
  });

  afterEach(() => {
    restoreCgroup();
    __resetContainerMemCacheForTests();
  });

  it('parses cgroup v2 numeric memory.max into MB', () => {
    // 31.7 GB = 31_700_000_000 bytes (POD1 live snapshot)
    mockCgroup({ v2: '31700000000\n' });
    const mb = readContainerTotalMemMBUncached();
    expect(mb).toBe(Math.floor(31_700_000_000 / 1024 / 1024));
    // POD1-class small container: under 31 GiB
    expect(mb).toBeLessThan(31_000);
  });

  it("falls back to host totalmem when cgroup v2 is 'max' (no limit)", () => {
    mockCgroup({ v2: 'max\n', v1: null });
    const mb = readContainerTotalMemMBUncached();
    expect(mb).toBe(Math.floor(os.totalmem() / 1024 / 1024));
  });

  it('parses cgroup v1 memory.limit_in_bytes when v2 missing', () => {
    // cgroup v1 with a 16 GB limit
    mockCgroup({ v2: null, v1: '16106127360\n' });
    const mb = readContainerTotalMemMBUncached();
    expect(mb).toBe(Math.floor(16_106_127_360 / 1024 / 1024));
  });

  it('falls back to host totalmem when both cgroup files are missing', () => {
    mockCgroup({ v2: null, v1: null });
    const mb = readContainerTotalMemMBUncached();
    expect(mb).toBe(Math.floor(os.totalmem() / 1024 / 1024));
  });

  it('treats cgroup v1 "no limit" sentinel (~9.2e18) as host fallback', () => {
    // Classic cgroup v1 unconstrained value: PAGE_COUNTER_MAX aligned
    mockCgroup({ v2: null, v1: '9223372036854771712\n' });
    const mb = readContainerTotalMemMBUncached();
    expect(mb).toBe(Math.floor(os.totalmem() / 1024 / 1024));
  });

  it('P2 fail-safe: malformed cgroup contents fall back to host totalmem', () => {
    mockCgroup({ v2: 'not-a-number\n', v1: 'also-garbage\n' });
    const mb = readContainerTotalMemMBUncached();
    expect(mb).toBe(Math.floor(os.totalmem() / 1024 / 1024));
  });

  it('memoizes the result across calls via getContainerTotalMemMB()', () => {
    mockCgroup({ v2: '8589934592\n' }); // 8 GB
    const a = getContainerTotalMemMB();
    const b = getContainerTotalMemMB();
    const c = getContainerTotalMemMB();
    expect(a).toBe(b);
    expect(b).toBe(c);
    // Exactly one read against the v2 path despite three getter calls
    const v2Reads = cgroupReads.filter(p => p === '/sys/fs/cgroup/memory.max');
    expect(v2Reads).toHaveLength(1);
  });
});

describe('container-mem — applyContainerMemoryGate()', () => {
  let infoSpy: jest.SpiedFunction<typeof logger.info>;

  beforeEach(() => {
    __resetContainerMemCacheForTests();
    cgroupReads.length = 0;
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    restoreCgroup();
    infoSpy.mockRestore();
    __resetContainerMemCacheForTests();
  });

  it('strips diloco_training when container total < default 40 GB threshold', () => {
    // POD1: 31.7 GB cgroup — below 40 GB DiLoCo threshold
    mockCgroup({ v2: '31700000000\n' });
    const out = applyContainerMemoryGate([
      'cpu_training',
      'gpu_training',
      'lora_training',
      'diloco_training',
    ]);
    expect(out).not.toContain('diloco_training');
    // LoRA threshold is 16 GB — POD1 clears it
    expect(out).toContain('lora_training');
    // Unfloored caps pass through untouched
    expect(out).toContain('cpu_training');
    expect(out).toContain('gpu_training');
  });

  it('keeps diloco_training when container total >= 40 GB threshold', () => {
    // 48 GB container — clears DiLoCo gate comfortably
    mockCgroup({ v2: '51539607552\n' });
    const out = applyContainerMemoryGate(['lora_training', 'diloco_training']);
    expect(out).toContain('diloco_training');
    expect(out).toContain('lora_training');
  });

  it('strips lora_training when container total < default 16 GB threshold', () => {
    // 8 GB container — fails LoRA AND DiLoCo
    mockCgroup({ v2: '8589934592\n' });
    const out = applyContainerMemoryGate(['lora_training', 'diloco_training']);
    expect(out).not.toContain('lora_training');
    expect(out).not.toContain('diloco_training');
  });

  it('cascades: stripping lora_training also strips its dependent lora_generation', () => {
    // 8 GB container — below the 16 GB LoRA bar. lora_generation has no own
    // threshold key, so without the dependency cascade it would leak through
    // after its parent lora_training is stripped.
    mockCgroup({ v2: '8589934592\n' });
    const out = applyContainerMemoryGate([
      'lora_training',
      'lora_generation',
      'cpu_training',
    ]);
    expect(out).not.toContain('lora_training');
    expect(out).not.toContain('lora_generation'); // cascaded with its parent
    expect(out).toContain('cpu_training'); // ungated cap untouched
  });

  it('keeps lora_generation when lora_training clears the container threshold', () => {
    // 24 GB container — clears the 16 GB LoRA bar, so neither lora_training nor
    // its dependent lora_generation is stripped (cascade must not over-fire).
    mockCgroup({ v2: '25769803776\n' });
    const out = applyContainerMemoryGate(['lora_training', 'lora_generation']);
    expect(out).toContain('lora_training');
    expect(out).toContain('lora_generation');
  });

  it('logs the strip decision exactly once per process lifetime', () => {
    mockCgroup({ v2: '8589934592\n' }); // 8 GB
    applyContainerMemoryGate(['diloco_training']);
    applyContainerMemoryGate(['diloco_training']);
    applyContainerMemoryGate(['diloco_training']);
    const stripLogs = infoSpy.mock.calls
      .map(c => String(c[0]))
      .filter(m => m.includes('[Capability] Container total RAM'));
    expect(stripLogs).toHaveLength(1);
    expect(stripLogs[0]).toContain('diloco_training (requires');
  });

  it('passes through unfloored caps untouched', () => {
    mockCgroup({ v2: '8589934592\n' });
    const out = applyContainerMemoryGate([
      'cpu_training',
      'gpu_training',
      'cpu_inference',
      'gpu_inference',
      'inference',
      'llm',
      'embedding',
      'docking',
    ]);
    expect(out).toEqual([
      'cpu_training',
      'gpu_training',
      'cpu_inference',
      'gpu_inference',
      'inference',
      'llm',
      'embedding',
      'docking',
    ]);
  });
});

describe('container-mem — env override (HEARTBEAT_DILOCO_MIN_CONTAINER_MB)', () => {
  const savedEnv = process.env.HEARTBEAT_DILOCO_MIN_CONTAINER_MB;

  afterEach(() => {
    restoreCgroup();
    if (savedEnv === undefined) {
      delete process.env.HEARTBEAT_DILOCO_MIN_CONTAINER_MB;
    } else {
      process.env.HEARTBEAT_DILOCO_MIN_CONTAINER_MB = savedEnv;
    }
    __resetContainerMemCacheForTests();
  });

  it('lowers the DiLoCo threshold when env override is set', () => {
    process.env.HEARTBEAT_DILOCO_MIN_CONTAINER_MB = '20000';
    __resetContainerMemCacheForTests(); // re-read env on reset
    expect(CONTAINER_MEM_THRESHOLDS.diloco_training).toBe(20_000);

    // 25 GB container — clears the lowered 20 GB threshold
    mockCgroup({ v2: '26843545600\n' });
    const out = applyContainerMemoryGate(['diloco_training']);
    expect(out).toContain('diloco_training');
  });

  it('reverts to default when env override removed', () => {
    delete process.env.HEARTBEAT_DILOCO_MIN_CONTAINER_MB;
    __resetContainerMemCacheForTests();
    expect(CONTAINER_MEM_THRESHOLDS.diloco_training).toBe(40_000);
  });

  it('ignores non-numeric env values and keeps default', () => {
    process.env.HEARTBEAT_DILOCO_MIN_CONTAINER_MB = 'not-a-number';
    __resetContainerMemCacheForTests();
    expect(CONTAINER_MEM_THRESHOLDS.diloco_training).toBe(40_000);
  });
});

describe('HeartbeatHelper.determineCapabilitiesAsync — Bug 21 container gate integration', () => {
  let helper: HeartbeatHelper;
  const realSetTimeout = global.setTimeout;
  let unrefingSetTimeout: typeof global.setTimeout;

  // Mirror heartbeat-lora-capability.spec timer-unref guard so the
  // CUDA probe (spawned when lora_training survives) doesn't pin the
  // worker via its 30s kill timer.
  beforeAll(() => {
    unrefingSetTimeout = ((handler: any, timeout?: number, ...args: any[]) => {
      const t = realSetTimeout(handler, timeout, ...args);
      if (typeof (t as any).unref === 'function') (t as any).unref();
      return t;
    }) as any;
    (unrefingSetTimeout as any).__promisify__ = (realSetTimeout as any).__promisify__;
    global.setTimeout = unrefingSetTimeout;
  });

  afterAll(() => {
    global.setTimeout = realSetTimeout;
  });

  beforeEach(() => {
    __resetCapabilitySnapshotForTests();
    helper = new HeartbeatHelper({ resolvePublicIp: jest.fn() } as any);
    // Probes succeed at the probe layer — we're isolating the
    // container-gate decision from those concerns.
    __seedLoraStackProbeForTests(true);
    __seedDilocoModelProbeForTests(true);
    // POD_HARDWARE is a CUDA-class GPU pod (A5000). Seed the CUDA cache to
    // `true` so the cpu/gpu_training split is DETERMINISTIC and host-independent:
    // without this, determineCapabilitiesAsync would fire a real
    // `python3 -c torch.cuda.is_available()` spawn (with a 30s kill timer) and
    // its result — hence whether cpu_training survives the split — would depend
    // on whether the test host actually has CUDA (passes on a Mac, fails on a
    // CUDA CI runner). Seeding pins it to the real-pod truth: CUDA present.
    __seedCudaCacheForTests(true);
  });

  afterEach(() => {
    restoreCgroup();
    __resetCapabilitySnapshotForTests();
    __seedCudaCacheForTests(null);
  });

  it('does NOT advertise diloco_training when container memory < threshold (POD1 live scenario)', async () => {
    // POD1: 31.7 GB cgroup v2 — below the 40 GB DiLoCo bar
    mockCgroup({ v2: '31700000000\n' });

    const caps = await helper.determineCapabilitiesAsync(POD_HARDWARE);

    expect(caps).not.toContain('diloco_training');
    // LoRA still survives (16 GB threshold, container has 31 GB)
    expect(caps).toContain('lora_training');
  });

  it('advertises diloco_training when container memory >= threshold', async () => {
    // 64 GB container — clears DiLoCo (40 GB) comfortably
    mockCgroup({ v2: '68719476736\n' });

    const caps = await helper.determineCapabilitiesAsync(POD_HARDWARE);

    expect(caps).toContain('diloco_training');
    expect(caps).toContain('lora_training');
  });

  it('does NOT advertise lora_training when container memory < LoRA threshold', async () => {
    // 12 GB container — fails LoRA (16 GB) AND DiLoCo
    mockCgroup({ v2: '12884901888\n' });

    // Hardware that would otherwise qualify (ramGb=32 on the wire) —
    // the container gate is independent of self-reported `hardware.ramGb`.
    const caps = await helper.determineCapabilitiesAsync(POD_HARDWARE);

    // Memory-floor target of this test: container < LoRA bar strips the
    // RAM-heavy training caps regardless of self-reported hardware.ramGb.
    expect(caps).not.toContain('lora_training');
    expect(caps).not.toContain('lora_generation'); // gated on lora_training
    expect(caps).not.toContain('diloco_training');
    // The container gate does NOT touch the cpu/gpu_training split — that is
    // CUDA-gated. POD_HARDWARE is a CUDA node (cache seeded true in beforeEach),
    // so it is GPU-only-always: gpu_training present, cpu_training absent. This
    // is independent of the container memory floor under test above.
    expect(caps).not.toContain('cpu_training');
    expect(caps).toContain('gpu_training');
  });
});
