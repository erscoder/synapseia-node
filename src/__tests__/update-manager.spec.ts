import {
  UpdateManager,
  MAX_SELF_UPDATE_ATTEMPTS,
  UPDATE_CHECK_INTERVAL_MS,
  SELF_UPDATE_BACKOFF_BASE_MS,
} from '../utils/update-manager';
import { UpdateStatus, type UpdateCheckResult } from '../utils/update-checker';
import type { SelfUpdateResult, RestartShutdownHandles } from '../utils/self-updater';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

// ── Test helpers ─────────────────────────────────────────────────────────────

function result(status: UpdateStatus, overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    status,
    currentVersion: '0.8.0',
    latestVersion: '0.9.0',
    minVersion: '0.7.0',
    ...overrides,
  };
}

function ok(version = '0.9.0'): SelfUpdateResult {
  return { success: true, installType: 'npm_global' as never, message: `Updated to v${version}` };
}

function fail(message = 'install blocked'): SelfUpdateResult {
  return { success: false, installType: 'npm_global' as never, message };
}

/**
 * Builds an UpdateManager with fully-stubbed deps. By default: idle (0
 * HEAVY), restart is a no-op stub (so the cycle continues in-test instead
 * of exiting), and the cross-lifetime marker is held in a local cell.
 */
function makeManager(opts: {
  check?: jest.Mock;
  selfUpdate?: jest.Mock;
  restart?: jest.Mock;
  heavy?: () => number;
  currentVersion?: () => string;
  intervalMs?: number;
  targetCell?: { value: string | undefined };
  setDraining?: jest.Mock;
} = {}) {
  const targetCell = opts.targetCell ?? { value: undefined as string | undefined };
  const check = opts.check ?? jest.fn().mockResolvedValue(result(UpdateStatus.UP_TO_DATE));
  const selfUpdate = opts.selfUpdate ?? jest.fn().mockResolvedValue(ok());
  const setDraining = opts.setDraining ?? jest.fn();
  // restartFn must NOT actually exit in tests. Resolve instead so the
  // cycle's `await restartFn(...)` returns.
  const restart =
    opts.restart ??
    (jest.fn().mockResolvedValue(undefined) as unknown as jest.Mock);
  const restartHandles: Omit<RestartShutdownHandles, 'respawn'> = {};
  const mgr = new UpdateManager({
    coordinatorUrl: 'https://coord.example',
    getActiveHeavyCount: opts.heavy ?? (() => 0),
    setDraining: setDraining as never,
    restartHandles,
    checkFn: check as never,
    selfUpdateFn: selfUpdate as never,
    restartFn: restart as never,
    getCurrentVersion: opts.currentVersion ?? (() => '0.8.0'),
    getRestartTarget: () => targetCell.value,
    setRestartTarget: (v: string) => { targetCell.value = v; },
    intervalMs: opts.intervalMs ?? UPDATE_CHECK_INTERVAL_MS,
  });
  return { mgr, check, selfUpdate, restart, targetCell, setDraining };
}

// ── Boot wiring ──────────────────────────────────────────────────────────────

describe('UpdateManager.start — boot wiring', () => {
  afterEach(() => jest.useRealTimers());

  it('fires the boot check exactly once (non-blocking) on start()', async () => {
    const { mgr, check } = makeManager();
    mgr.start();
    // start() must return synchronously without awaiting the check.
    expect(check).toHaveBeenCalledTimes(1);
    await Promise.resolve(); // let the boot cycle settle
    mgr.stop();
  });

  it('is idempotent — calling start() twice does not double-arm', () => {
    jest.useFakeTimers();
    const { mgr, check } = makeManager();
    mgr.start();
    mgr.start();
    expect(check).toHaveBeenCalledTimes(1); // only the first boot check
    mgr.stop();
  });
});

// ── Periodic timer ───────────────────────────────────────────────────────────

describe('UpdateManager — periodic re-check', () => {
  afterEach(() => jest.useRealTimers());

  it('re-checks on the interval and the timer is unref\'d + cleared on stop', async () => {
    jest.useFakeTimers();
    const unref = jest.spyOn(global, 'setInterval');
    const { mgr, check } = makeManager({ intervalMs: 1000 });
    mgr.start(); // boot check #1
    await Promise.resolve();

    // The setInterval handle must be unref'd (never keeps the process alive).
    const handle = unref.mock.results[0].value as NodeJS.Timeout;
    expect(typeof handle.unref).toBe('function');

    await jest.advanceTimersByTimeAsync(1000); // re-check #2
    await jest.advanceTimersByTimeAsync(1000); // re-check #3
    expect(check).toHaveBeenCalledTimes(3);

    mgr.stop();
    await jest.advanceTimersByTimeAsync(5000); // no more checks after stop
    expect(check).toHaveBeenCalledTimes(3);
    unref.mockRestore();
  });
});

// ── Update-status routing ────────────────────────────────────────────────────

describe('UpdateManager.runCycle — status routing', () => {
  it('UP_TO_DATE → does NOT call attemptSelfUpdate', async () => {
    const { mgr, selfUpdate } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UP_TO_DATE)),
    });
    await mgr.runCycle();
    expect(selfUpdate).not.toHaveBeenCalled();
  });

  it('null check (npm unreachable) → does NOT call attemptSelfUpdate', async () => {
    const { mgr, selfUpdate } = makeManager({
      check: jest.fn().mockResolvedValue(null),
    });
    await mgr.runCycle();
    expect(selfUpdate).not.toHaveBeenCalled();
  });

  it('UPDATE_AVAILABLE → calls attemptSelfUpdate with the npm-latest target version', async () => {
    const { mgr, selfUpdate } = makeManager({
      check: jest.fn().mockResolvedValue(
        result(UpdateStatus.UPDATE_AVAILABLE, { latestVersion: '0.8.106' }),
      ),
    });
    await mgr.runCycle();
    expect(selfUpdate).toHaveBeenCalledTimes(1);
    // The pinned target version (npm dist-tags `latest`) is threaded through,
    // NOT the coordinator URL.
    expect(selfUpdate).toHaveBeenCalledWith('0.8.106');
  });

  it('UPDATE_REQUIRED → calls attemptSelfUpdate with the npm-latest target version', async () => {
    const { mgr, selfUpdate } = makeManager({
      check: jest.fn().mockResolvedValue(
        result(UpdateStatus.UPDATE_REQUIRED, { latestVersion: '0.8.106' }),
      ),
    });
    await mgr.runCycle();
    expect(selfUpdate).toHaveBeenCalledTimes(1);
    expect(selfUpdate).toHaveBeenCalledWith('0.8.106');
  });
});

// ── Idle-gated restart ───────────────────────────────────────────────────────

describe('UpdateManager.runCycle — idle gating', () => {
  it('successful update + IDLE → restart invoked once with respawn:true', async () => {
    const { mgr, restart, targetCell } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UPDATE_AVAILABLE)),
      selfUpdate: jest.fn().mockResolvedValue(ok('0.9.0')),
      heavy: () => 0,
    });
    await mgr.runCycle();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith(expect.objectContaining({ respawn: true }));
    // Target version stamped for cross-lifetime loop-protection.
    expect(targetCell.value).toBe('0.9.0');
  });

  it('successful update while a HEAVY WO is active → restart DEFERRED (not invoked)', async () => {
    const selfUpdate = jest.fn().mockResolvedValue(ok());
    const { mgr, restart } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UPDATE_AVAILABLE)),
      selfUpdate,
      heavy: () => 1, // one HEAVY training WO in flight
    });
    await mgr.runCycle();
    // Must not even attempt the install/restart while heavy work is running.
    expect(selfUpdate).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it('defers while HEAVY, then restarts on the next idle cycle', async () => {
    let heavyCount = 1;
    const { mgr, restart } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UPDATE_AVAILABLE)),
      selfUpdate: jest.fn().mockResolvedValue(ok()),
      heavy: () => heavyCount,
    });
    await mgr.runCycle(); // heavy → deferred
    expect(restart).not.toHaveBeenCalled();
    heavyCount = 0; // training finished
    await mgr.runCycle(); // idle → restart
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

// ── Drain gate (idle-gate race) ───────────────────────────────────────────────

describe('UpdateManager.runCycle — drain gate closes the idle-gate race', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sets draining(true) BEFORE the install, then restarts when still idle', async () => {
    const setDraining = jest.fn();
    const callOrder: string[] = [];
    const selfUpdate = jest.fn().mockImplementation(async () => {
      callOrder.push('install');
      return ok();
    });
    setDraining.mockImplementation((v: boolean) => callOrder.push(`drain:${v}`));
    const restart = jest.fn().mockImplementation(async () => {
      callOrder.push('restart');
    });
    const { mgr } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UPDATE_AVAILABLE)),
      selfUpdate,
      restart,
      setDraining,
      heavy: () => 0,
    });
    const p = mgr.runCycle();
    await jest.runOnlyPendingTimersAsync();
    await p;
    // draining(true) must precede the install; restart fires after.
    expect(callOrder).toEqual(['drain:true', 'install', 'restart']);
    // It is NOT cleared on the happy path — the process is exiting and the
    // respawned child boots with a fresh, non-draining BackpressureService.
    expect(setDraining).toHaveBeenCalledTimes(1);
  });

  it('HEAVY WO becomes active during the (slow) install → ABORT restart, clear draining', async () => {
    const setDraining = jest.fn();
    // 0 HEAVY at the idle-gate check; 1 HEAVY by the re-confirm before exit.
    let heavyCount = 0;
    const selfUpdate = jest.fn().mockImplementation(async () => {
      heavyCount = 1; // a training WO slipped in during the long install
      return ok();
    });
    const restart = jest.fn().mockResolvedValue(undefined);
    const { mgr } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UPDATE_AVAILABLE)),
      selfUpdate,
      restart,
      setDraining,
      heavy: () => heavyCount,
    });
    const p = mgr.runCycle();
    await jest.runOnlyPendingTimersAsync();
    await p;
    expect(selfUpdate).toHaveBeenCalledTimes(1); // install ran
    expect(restart).not.toHaveBeenCalled(); // restart ABORTED — no mid-WO exit
    // draining set true before install, then cleared on abort.
    expect(setDraining.mock.calls).toEqual([[true], [false]]);
  });

  it('install failure clears draining (resumes HEAVY acceptance)', async () => {
    const setDraining = jest.fn();
    const { mgr, restart } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UPDATE_AVAILABLE)),
      selfUpdate: jest.fn().mockResolvedValue(fail()),
      setDraining,
      heavy: () => 0,
    });
    const p = mgr.runCycle();
    await jest.runOnlyPendingTimersAsync();
    await p;
    expect(restart).not.toHaveBeenCalled();
    expect(setDraining.mock.calls).toEqual([[true], [false]]);
  });

  it('install throw clears draining (resumes HEAVY acceptance)', async () => {
    const setDraining = jest.fn();
    const { mgr, restart } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UPDATE_AVAILABLE)),
      selfUpdate: jest.fn().mockRejectedValue(new Error('npm boom')),
      setDraining,
      heavy: () => 0,
    });
    const p = mgr.runCycle();
    await jest.runOnlyPendingTimersAsync();
    await p;
    expect(restart).not.toHaveBeenCalled();
    expect(setDraining.mock.calls).toEqual([[true], [false]]);
  });

  it('never sets draining while HEAVY is already active (deferred before staging)', async () => {
    const setDraining = jest.fn();
    const { mgr } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UPDATE_AVAILABLE)),
      selfUpdate: jest.fn().mockResolvedValue(ok()),
      setDraining,
      heavy: () => 1, // busy at the idle-gate check
    });
    await mgr.runCycle();
    expect(setDraining).not.toHaveBeenCalled();
  });
});

// ── Loop protection ──────────────────────────────────────────────────────────

describe('UpdateManager.runCycle — loop protection', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('repeated install failures never exceed MAX_SELF_UPDATE_ATTEMPTS', async () => {
    const selfUpdate = jest.fn().mockResolvedValue(fail());
    const { mgr } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UPDATE_AVAILABLE)),
      selfUpdate,
    });
    // Drive many cycles; backoff sleeps are flushed via fake timers.
    for (let i = 0; i < 6; i++) {
      const p = mgr.runCycle();
      await jest.runOnlyPendingTimersAsync();
      await p;
    }
    expect(selfUpdate.mock.calls.length).toBe(MAX_SELF_UPDATE_ATTEMPTS);
  });

  it('applies exponential backoff between attempts', async () => {
    const selfUpdate = jest.fn().mockResolvedValue(fail());
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const { mgr } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UPDATE_AVAILABLE)),
      selfUpdate,
    });
    const p1 = mgr.runCycle(); // attempt 1 — no backoff
    await jest.runOnlyPendingTimersAsync();
    await p1;
    const p2 = mgr.runCycle(); // attempt 2 — base backoff
    await jest.runOnlyPendingTimersAsync();
    await p2;
    // The second attempt must have scheduled a backoff of the base delay.
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), SELF_UPDATE_BACKOFF_BASE_MS);
    setTimeoutSpy.mockRestore();
  });

  it('restart is never invoked more than once per cycle (re-entrancy guard)', async () => {
    const { mgr, restart } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UPDATE_AVAILABLE)),
      selfUpdate: jest.fn().mockResolvedValue(ok()),
    });
    // Fire two overlapping cycles; the second must short-circuit.
    const a = mgr.runCycle();
    const b = mgr.runCycle();
    await Promise.all([a, b]);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('post-restart still-stale (cross-lifetime) → latches giveUp, no further attempts', async () => {
    // Simulate a freshly-booted process that was restarted to reach 0.9.0
    // but is STILL on 0.8.0 → install did not take.
    const selfUpdate = jest.fn().mockResolvedValue(ok());
    const { mgr } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UPDATE_AVAILABLE)),
      selfUpdate,
      currentVersion: () => '0.8.0',
      targetCell: { value: '0.9.0' }, // marker from the prior lifetime
    });
    await mgr.runCycle();
    await mgr.runCycle();
    expect(selfUpdate).not.toHaveBeenCalled(); // halted — no restart loop
  });
});

// ── Fail-closed ──────────────────────────────────────────────────────────────

describe('UpdateManager.runCycle — fail-closed', () => {
  it('a thrown error in the check does not propagate', async () => {
    const { mgr } = makeManager({
      check: jest.fn().mockRejectedValue(new Error('coord boom')),
    });
    await expect(mgr.runCycle()).resolves.toBeUndefined();
  });

  it('a thrown error in the install does not propagate or restart', async () => {
    const { mgr, restart } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UPDATE_AVAILABLE)),
      selfUpdate: jest.fn().mockRejectedValue(new Error('npm boom')),
    });
    await expect(mgr.runCycle()).resolves.toBeUndefined();
    expect(restart).not.toHaveBeenCalled();
  });

  it('a thrown error in the restart does not propagate', async () => {
    const { mgr } = makeManager({
      check: jest.fn().mockResolvedValue(result(UpdateStatus.UPDATE_AVAILABLE)),
      selfUpdate: jest.fn().mockResolvedValue(ok()),
      restart: jest.fn().mockRejectedValue(new Error('restart boom')),
    });
    await expect(mgr.runCycle()).resolves.toBeUndefined();
  });

  it('start() boot cycle swallows a thrown check error (no crash at boot)', async () => {
    const { mgr } = makeManager({
      check: jest.fn().mockRejectedValue(new Error('boot check boom')),
    });
    // start() is fire-and-forget; the rejected boot cycle must not surface
    // as an unhandled rejection that would crash startup.
    expect(() => mgr.start()).not.toThrow();
    await new Promise<void>((r) => setTimeout(r, 10));
    mgr.stop();
  });
});
