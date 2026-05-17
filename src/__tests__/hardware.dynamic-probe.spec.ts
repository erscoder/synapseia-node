/**
 * Hardware dynamic probe TTL tests (Bug 28 — Plan B Slice 2, 2026-05-17).
 *
 * Pod live-confirmed: Ollama UP on localhost:11434, but heartbeat
 * advertised cpu_training/cpu_inference/gpu_training only — coord
 * rejected RESEARCH WOs with NODE_FORBIDDEN. Root cause: hardwareCache
 * pinned `hasOllama=false` for process lifetime after one transient
 * boot-time miss.
 *
 * These tests verify the new contract:
 *   1. First call to detectHardware() probes Ollama.
 *   2. Subsequent calls within DYNAMIC_PROBE_TTL_MS (60s) return cache.
 *   3. Calls after the TTL window re-probe.
 *   4. down→UP transitions surface on next post-TTL call.
 *   5. UP→down transitions surface on next post-TTL call + emit WARN log.
 */

import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';

// Mock child_process — both execSync (GPU probe) and spawnSync (Ollama probe).
const mockExecSync = jest.fn();
const mockSpawnSync = jest.fn();
jest.mock('child_process', () => ({
  execSync: mockExecSync,
  spawnSync: mockSpawnSync,
}));

// Mock os — Apple Silicon arm64 to skip the nvidia-smi path entirely.
// Includes homedir/tmpdir because hardware.ts transitively imports
// python-venv.ts which evaluates homedir() at module load.
jest.mock('os', () => ({
  cpus: () => Array(8).fill({ model: 'Apple M3 Max' }),
  totalmem: () => 16 * 1024 ** 3,
  platform: () => 'darwin',
  release: () => '23.0.0',
  arch: () => 'arm64',
  type: () => 'Darwin',
  homedir: () => '/tmp/test-home',
  tmpdir: () => '/tmp',
}));

describe('hardware dynamic probe TTL (Bug 28)', () => {
  let nowMs = 1_700_000_000_000;
  let dateNowSpy: jest.SpiedFunction<typeof Date.now>;

  beforeEach(async () => {
    jest.clearAllMocks();
    // execSync covers the static GPU probe (sysctl on arm64). Return a
    // stable Apple model so the static slice is deterministic.
    mockExecSync.mockReturnValue('Apple M3 Max');
    // Default Ollama spawn returns DOWN. Each test overrides as needed.
    mockSpawnSync.mockReturnValue({ status: 1, error: undefined });

    // Freeze Date.now so the TTL math is deterministic. Tests advance
    // `nowMs` explicitly between probe attempts. Production code uses
    // real Date.now() per project rule P24.
    nowMs = 1_700_000_000_000;
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);

    // Reset BOTH caches between tests so probe state from one case
    // does not poison the next.
    const { resetHardwareCache } = await import('../modules/hardware/hardware.js');
    resetHardwareCache();

    // Strip env that would short-circuit the Ollama probe direction.
    delete process.env.OLLAMA_URL;
    delete process.env.LLM_CLOUD_MODEL;
    delete process.env.LLM_PROVIDER;
  });

  afterEach(() => {
    dateNowSpy?.mockRestore();
  });

  it('probes Ollama on first call', async () => {
    const { detectHardware } = await import('../modules/hardware/hardware.js');
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined });

    const hw = detectHardware(false);

    expect(hw.hasOllama).toBe(true);
    // Exactly one spawnSync call to the Ollama probe URL.
    const ollamaCalls = mockSpawnSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).some((arg: string) => arg.includes('/api/tags')),
    );
    expect(ollamaCalls.length).toBe(1);
  });

  it('returns cached dynamic value on second call within TTL', async () => {
    const { detectHardware } = await import('../modules/hardware/hardware.js');
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined });

    const hw1 = detectHardware(false);
    expect(hw1.hasOllama).toBe(true);

    // Advance 30s — well inside the 60s TTL window.
    nowMs += 30_000;

    const hw2 = detectHardware(false);
    expect(hw2.hasOllama).toBe(true);

    // Still exactly ONE Ollama probe call; second was served from cache.
    const ollamaCalls = mockSpawnSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).some((arg: string) => arg.includes('/api/tags')),
    );
    expect(ollamaCalls.length).toBe(1);
  });

  it('re-probes after TTL expires (61s later)', async () => {
    const { detectHardware } = await import('../modules/hardware/hardware.js');
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined });

    detectHardware(false);

    // Advance 61s — TTL has just expired (TTL = 60_000 ms).
    nowMs += 61_000;

    detectHardware(false);

    const ollamaCalls = mockSpawnSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).some((arg: string) => arg.includes('/api/tags')),
    );
    expect(ollamaCalls.length).toBe(2);
  });

  it('reflects down→UP transition on next post-TTL probe', async () => {
    const { detectHardware } = await import('../modules/hardware/hardware.js');
    // Boot probe: Ollama DOWN (status !== 0).
    mockSpawnSync.mockReturnValueOnce({ status: 1, error: undefined });

    const hw1 = detectHardware(false);
    expect(hw1.hasOllama).toBe(false);

    // Ollama comes UP between heartbeats. Next probe returns OK.
    mockSpawnSync.mockReturnValueOnce({ status: 0, error: undefined });

    // Advance past TTL so the next call re-probes.
    nowMs += 61_000;

    const hw2 = detectHardware(false);
    expect(hw2.hasOllama).toBe(true);
  });

  it('reflects UP→down transition + emits WARN log', async () => {
    // Spy on the project logger (default export from utils/logger).
    const loggerModule = await import('../utils/logger.js');
    const logger = (loggerModule as unknown as { default: { warn: (...a: unknown[]) => void } }).default;
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const { detectHardware } = await import('../modules/hardware/hardware.js');

    // Boot probe: Ollama UP.
    mockSpawnSync.mockReturnValueOnce({ status: 0, error: undefined });
    const hw1 = detectHardware(false);
    expect(hw1.hasOllama).toBe(true);

    // First UP probe never logs a transition (no prior state).
    expect(warnSpy).not.toHaveBeenCalled();

    // Ollama dies. Next probe returns failure.
    mockSpawnSync.mockReturnValueOnce({ status: 7, error: new Error('curl: connection refused') });
    nowMs += 61_000;

    const hw2 = detectHardware(false);
    expect(hw2.hasOllama).toBe(false);

    // WARN log must mention the UP -> DOWN transition.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = warnSpy.mock.calls[0][0] as string;
    expect(warnArg).toMatch(/Ollama state changed/);
    expect(warnArg).toMatch(/UP -> DOWN/);
    expect(warnArg).toMatch(/will be stripped/);

    warnSpy.mockRestore();
  });

  it('honors OLLAMA_PROBE_TIMEOUT_MS env override', async () => {
    process.env.OLLAMA_PROBE_TIMEOUT_MS = '5000';
    const { detectHardware } = await import('../modules/hardware/hardware.js');
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined });

    detectHardware(false);

    const ollamaCall = mockSpawnSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).some((arg: string) => arg.includes('/api/tags')),
    );
    expect(ollamaCall).toBeDefined();
    const args = ollamaCall![1] as string[];
    const maxTimeIdx = args.indexOf('--max-time');
    // 5000ms -> ceil(5000/1000) = "5"
    expect(args[maxTimeIdx + 1]).toBe('5');
    // Third arg of spawnSync is options; check timeout passed through.
    const opts = ollamaCall![2] as { timeout?: number };
    expect(opts.timeout).toBe(5000);

    delete process.env.OLLAMA_PROBE_TIMEOUT_MS;
  });

  it('static slice (cpuCores/ramGb/gpuVramGb) is cached across calls', async () => {
    const { detectHardware } = await import('../modules/hardware/hardware.js');
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined });

    detectHardware(false);
    const execCallsAfterFirst = mockExecSync.mock.calls.length;

    // Two more calls within TTL.
    nowMs += 10_000;
    detectHardware(false);
    nowMs += 10_000;
    detectHardware(false);

    // No additional GPU probes were issued — static cache served them.
    expect(mockExecSync.mock.calls.length).toBe(execCallsAfterFirst);
  });
});
