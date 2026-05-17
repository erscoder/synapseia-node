/**
 * Tests for ollama-pause.ts (Bug 27 — pause Ollama daemon during DiLoCo
 * training on memory-constrained containers).
 *
 * Test boundary:
 *   - `fetch` is replaced via the module-private `__setFetchForTests`
 *     hook (mirrors the pattern used by container-mem's
 *     `__setReadFileSyncForTests`). Real `global.fetch` is never
 *     reached.
 *   - `spawn` is replaced via `__setSpawnForTests`. The fake spawn
 *     returns an EventEmitter-shaped stub that we can drive with
 *     `.emit('close')` / `.emit('error')`.
 *   - `getContainerTotalMemMB` is mocked at the module level via
 *     `jest.mock` so we can flip the container size per test without
 *     touching cgroup files.
 *   - `logger` is mocked to silence output and to allow assertion on
 *     the WARN/INFO emitted by the pause/restart cycle.
 *
 * Per P29: we exercise real-time polling intervals. The polls inside
 * stopOllamaDaemon / startOllamaDaemon use `setTimeout(500)`, so the
 * fake `fetch` returns the desired state on the FIRST probe to keep
 * each test under a few hundred ms.
 */

import { EventEmitter } from 'node:events';

// --- Mock container-mem so we can control the threshold side per test.
jest.mock('../../heartbeat/container-mem', () => ({
  getContainerTotalMemMB: jest.fn(),
}));

// --- Mock logger to silence + assert.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: {
    log: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  maybePauseOllamaForDiloco,
  maybeRestartOllamaAfterDiloco,
  __setFetchForTests,
  __setSpawnForTests,
  DILOCO_OLLAMA_PAUSE_THRESHOLD_MB,
} from '../ollama-pause';
import { getContainerTotalMemMB } from '../../heartbeat/container-mem';
import logger from '../../../utils/logger';

type SpawnArgs = { cmd: string; args: string[] };

/** Build a fake ChildProcess-shaped stub with .emit() support. */
function makeFakeChild(): EventEmitter & { unref: jest.Mock } {
  const ee = new EventEmitter() as EventEmitter & { unref: jest.Mock };
  ee.unref = jest.fn();
  return ee;
}

describe('ollama-pause (Bug 27)', () => {
  let spawnCalls: SpawnArgs[];
  let lastChild: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    spawnCalls = [];
    lastChild = makeFakeChild();
    __setSpawnForTests((cmd, args) => {
      spawnCalls.push({ cmd, args });
      lastChild = makeFakeChild();
      // pkill exits successfully on the same tick; ollama serve never
      // exits (it's a daemon) so we don't auto-emit close on that path.
      if (cmd === 'pkill') {
        setImmediate(() => lastChild.emit('close', 0));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return lastChild as any;
    });
    (logger.warn as jest.Mock).mockClear();
    (logger.info as jest.Mock).mockClear();
  });

  afterEach(() => {
    __setFetchForTests(null);
    __setSpawnForTests(null);
    (getContainerTotalMemMB as jest.Mock).mockReset();
  });

  /* ------------------------------------------------------------------ */
  /* Threshold gate                                                       */
  /* ------------------------------------------------------------------ */

  it('NO-OP when container is at or above the threshold', async () => {
    (getContainerTotalMemMB as jest.Mock).mockReturnValue(
      DILOCO_OLLAMA_PAUSE_THRESHOLD_MB,
    );
    // Even if Ollama is up, the threshold gate trips first.
    __setFetchForTests(
      jest.fn(async () => ({ ok: true }) as unknown as Response),
    );

    const handle = await maybePauseOllamaForDiloco();

    expect(handle).toEqual({ wasRunning: false, pausedAt: 0 });
    expect(spawnCalls).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('NO-OP when container below threshold but Ollama is NOT running', async () => {
    (getContainerTotalMemMB as jest.Mock).mockReturnValue(40_000);
    // First and only probe says "down".
    __setFetchForTests(
      jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const handle = await maybePauseOllamaForDiloco();

    expect(handle.wasRunning).toBe(false);
    expect(spawnCalls).toHaveLength(0); // never tried to pkill
    expect(logger.warn).not.toHaveBeenCalled();
  });

  /* ------------------------------------------------------------------ */
  /* Pause + restart cycle                                               */
  /* ------------------------------------------------------------------ */

  it('pauses Ollama then restarts when container below threshold and Ollama up', async () => {
    (getContainerTotalMemMB as jest.Mock).mockReturnValue(46_000);

    // Probe sequence: alive, dead-after-pkill, alive-after-restart.
    const fetchMock = jest
      .fn()
      // (1) initial isOllamaRunning => alive
      .mockResolvedValueOnce({ ok: true } as unknown as Response)
      // (2) post-pkill waitUntil first immediate probe => dead
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      // (3) post-spawn waitUntil first immediate probe => alive
      .mockResolvedValueOnce({ ok: true } as unknown as Response);
    __setFetchForTests(fetchMock);

    const handle = await maybePauseOllamaForDiloco();

    expect(handle.wasRunning).toBe(true);
    expect(handle.pausedAt).toBeGreaterThan(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual({
      cmd: 'pkill',
      args: ['-TERM', '-f', 'ollama serve'],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[Bug 27] Container 46000MB'),
    );

    // Now restart.
    await maybeRestartOllamaAfterDiloco(handle);

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]).toEqual({ cmd: 'ollama', args: ['serve'] });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[Bug 27] Restarting Ollama'),
    );
  });

  /* ------------------------------------------------------------------ */
  /* Restart is no-op when we didn't pause                               */
  /* ------------------------------------------------------------------ */

  it('restart is no-op for a handle with wasRunning=false', async () => {
    await maybeRestartOllamaAfterDiloco({ wasRunning: false, pausedAt: 0 });

    expect(spawnCalls).toHaveLength(0);
    expect(logger.info).not.toHaveBeenCalled();
  });

  /* ------------------------------------------------------------------ */
  /* End-to-end via try/finally (DiLoCo failure path)                    */
  /* ------------------------------------------------------------------ */

  it('restart still fires when the wrapped task throws (try/finally semantics)', async () => {
    (getContainerTotalMemMB as jest.Mock).mockReturnValue(46_000);

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true } as unknown as Response) // initial alive
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // dead after pkill
      .mockResolvedValueOnce({ ok: true } as unknown as Response); // alive after restart
    __setFetchForTests(fetchMock);

    const handle = await maybePauseOllamaForDiloco();
    let threw = false;
    try {
      try {
        throw new Error('simulated DiLoCo SIGKILL');
      } finally {
        await maybeRestartOllamaAfterDiloco(handle);
      }
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(spawnCalls.map((c) => c.cmd)).toEqual(['pkill', 'ollama']);
  });

  /* ------------------------------------------------------------------ */
  /* Env override                                                        */
  /* ------------------------------------------------------------------ */

  it('env override DILOCO_OLLAMA_PAUSE_THRESHOLD_MB is honored at module load', () => {
    // The constant is resolved at module-load (P28: thresholds + env
    // override centralized in one file, resolved once). The default
    // when the env var is unset is 80 000 MB.
    expect(DILOCO_OLLAMA_PAUSE_THRESHOLD_MB).toBe(80_000);

    // The override path is verified by isolated re-import + env set,
    // which jest supports via jest.isolateModulesAsync. We use a child
    // re-import here rather than monkey-patching the const (which would
    // be a no-op since modules are frozen post-load).
    const prev = process.env.DILOCO_OLLAMA_PAUSE_THRESHOLD_MB;
    process.env.DILOCO_OLLAMA_PAUSE_THRESHOLD_MB = '120000';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../ollama-pause');
      expect(mod.DILOCO_OLLAMA_PAUSE_THRESHOLD_MB).toBe(120_000);
    });
    if (prev === undefined) {
      delete process.env.DILOCO_OLLAMA_PAUSE_THRESHOLD_MB;
    } else {
      process.env.DILOCO_OLLAMA_PAUSE_THRESHOLD_MB = prev;
    }
  });

  it('env override is ignored when not a positive integer (falls back to default)', () => {
    const prev = process.env.DILOCO_OLLAMA_PAUSE_THRESHOLD_MB;
    process.env.DILOCO_OLLAMA_PAUSE_THRESHOLD_MB = 'not-a-number';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../ollama-pause');
      expect(mod.DILOCO_OLLAMA_PAUSE_THRESHOLD_MB).toBe(80_000);
    });
    process.env.DILOCO_OLLAMA_PAUSE_THRESHOLD_MB = '0';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../ollama-pause');
      expect(mod.DILOCO_OLLAMA_PAUSE_THRESHOLD_MB).toBe(80_000);
    });
    if (prev === undefined) {
      delete process.env.DILOCO_OLLAMA_PAUSE_THRESHOLD_MB;
    } else {
      process.env.DILOCO_OLLAMA_PAUSE_THRESHOLD_MB = prev;
    }
  });

  /* ------------------------------------------------------------------ */
  /* Fail-open: pkill spawn error does not block DiLoCo                  */
  /* ------------------------------------------------------------------ */

  it('pkill error event is logged and pause proceeds to wait-poll (fail-open per P2 tradeoff)', async () => {
    (getContainerTotalMemMB as jest.Mock).mockReturnValue(46_000);
    // Initial probe alive, post-pkill probe dead.
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true } as unknown as Response)
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    __setFetchForTests(fetchMock);

    // Spawn returns a child that emits 'error' instead of 'close'.
    __setSpawnForTests((cmd) => {
      spawnCalls.push({ cmd, args: [] });
      const ee = makeFakeChild();
      if (cmd === 'pkill') {
        setImmediate(() => ee.emit('error', new Error('pkill missing')));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ee as any;
    });

    const handle = await maybePauseOllamaForDiloco();

    expect(handle.wasRunning).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('pkill spawn failed'),
    );
  });

  /* ------------------------------------------------------------------ */
  /* Sync-throw paths (pkill spawn throws / ollama serve spawn throws)   */
  /* ------------------------------------------------------------------ */

  it('pkill synchronous spawn throw is caught and logged', async () => {
    (getContainerTotalMemMB as jest.Mock).mockReturnValue(46_000);

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true } as unknown as Response) // alive
      .mockRejectedValueOnce(new Error('ECONNREFUSED')); // dead post-pkill
    __setFetchForTests(fetchMock);

    __setSpawnForTests((cmd) => {
      spawnCalls.push({ cmd, args: [] });
      if (cmd === 'pkill') {
        throw new Error('spawn EACCES');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return makeFakeChild() as any;
    });

    const handle = await maybePauseOllamaForDiloco();

    expect(handle.wasRunning).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('pkill threw synchronously'),
    );
  });

  it('ollama serve synchronous spawn throw is wrapped and logged via restart WARN', async () => {
    // Restart path: spawn throws synchronously => startOllamaDaemon
    // throws => maybeRestartOllamaAfterDiloco catches + WARNs.
    const fetchMock = jest.fn(async () => {
      throw new Error('dead');
    });
    __setFetchForTests(fetchMock);
    __setSpawnForTests((cmd) => {
      spawnCalls.push({ cmd, args: [] });
      throw new Error('ENOENT ollama');
    });

    await maybeRestartOllamaAfterDiloco({
      wasRunning: true,
      pausedAt: Date.now() - 1000,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Ollama restart did not confirm'),
    );
  });

  /* ------------------------------------------------------------------ */
  /* Reset hooks restore real implementations                            */
  /* ------------------------------------------------------------------ */

  it('__setFetchForTests(null) and __setSpawnForTests(null) restore defaults', () => {
    // The defaults are closures over `fetch` and `realSpawn`; we just
    // assert the setters accept null without throwing.
    expect(() => __setFetchForTests(null)).not.toThrow();
    expect(() => __setSpawnForTests(null)).not.toThrow();
  });

  /* ------------------------------------------------------------------ */
  /* Restart failure is swallowed (caller is in `finally`)               */
  /* ------------------------------------------------------------------ */

  it('restart failure is logged WARN and does not throw (so finally cannot mask the original error)', async () => {
    // Probe always says "dead" => restart will time out, throw, get
    // caught + logged. Use a very short fake by overriding the
    // ollama-pause module's poll windows is not possible without
    // re-importing, so we accept the 30 s ceiling and use jest fake
    // timers ONLY for this test.
    jest.useFakeTimers();
    try {
      const fetchMock = jest.fn(async () => {
        throw new Error('still dead');
      });
      __setFetchForTests(fetchMock);

      const restartP = maybeRestartOllamaAfterDiloco({
        wasRunning: true,
        pausedAt: Date.now() - 1000,
      });

      // Spawn happened immediately.
      expect(spawnCalls).toEqual([{ cmd: 'ollama', args: ['serve'] }]);

      // Advance through every 500 ms poll until the 30 s deadline.
      // Each poll iteration awaits a microtask after the timer fires,
      // so we interleave timer advance with promise flush.
      for (let i = 0; i < 65; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
        jest.advanceTimersByTime(500);
      }
      await jest.runOnlyPendingTimersAsync();

      // The restart promise resolves (does NOT throw) — caller's
      // finally block is safe.
      await expect(restartP).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Ollama restart did not confirm'),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
