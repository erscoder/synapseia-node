/**
 * Tests for the OS-aware docking dependency auto-installer.
 *
 * The installer is exercised via injected stubs (execSyncFn / platform / env)
 * so we never actually shell out to a package manager. Each test verifies the
 * exact command(s) that would be issued and the {installed, reason} contract.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { installDockingDeps, extractExitCode, extractStderrTail } from '../install';

type ExecCall = { cmd: string };

/**
 * Build a stub `execSync` that returns successfully for command-prefix matches
 * in `successPrefixes` and throws otherwise. Records every invocation.
 */
function makeExecStub(successPrefixes: string[]) {
  const calls: ExecCall[] = [];
  const fn = jest.fn((cmd: unknown) => {
    const c = String(cmd);
    calls.push({ cmd: c });
    if (successPrefixes.some((p) => c.startsWith(p))) {
      return Buffer.from('');
    }
    throw new Error(`stub: command not allowed: ${c}`);
  });
  // Cast through unknown — execSync has many overloads, we only need the call signature.
  return { fn: fn as unknown as typeof import('node:child_process').execSync, calls };
}

/**
 * Build a stub that succeeds on `apt-get --version` and returns a programmed
 * sequence of exit codes for each subsequent `sudo apt-get install` call.
 * Each entry is either:
 *   - a `number` ≠ 0 → throw an Error with that exit `.status` + given stderr,
 *   - `'ok'`         → succeed (Buffer empty),
 *   - `{exit, stderr}` for full control.
 *
 * Stub fails any other command (e.g. dnf) so tests that expect NO fallback
 * naturally assert it.
 */
type AptStep = 'ok' | number | { exit: number; stderr?: string };
function makeAptStub(installSteps: AptStep[]) {
  const calls: ExecCall[] = [];
  let installCallIdx = 0;
  const fn = jest.fn((cmd: unknown) => {
    const c = String(cmd);
    calls.push({ cmd: c });
    if (c === 'apt-get --version') {
      return Buffer.from('apt 2.4.0');
    }
    if (c.startsWith('sudo apt-get install')) {
      const step = installSteps[installCallIdx++];
      if (step === undefined) {
        throw new Error(`stub: install step ${installCallIdx - 1} not programmed`);
      }
      if (step === 'ok') return Buffer.from('');
      const exit = typeof step === 'number' ? step : step.exit;
      const stderr = typeof step === 'object' ? (step.stderr ?? '') : '';
      const err = new Error(`Command failed: ${c}`) as Error & {
        status: number;
        stderr: Buffer;
      };
      err.status = exit;
      err.stderr = Buffer.from(stderr);
      throw err;
    }
    throw new Error(`stub: command not allowed: ${c}`);
  });
  return { fn: fn as unknown as typeof import('node:child_process').execSync, calls };
}

/** No-op sleep stub for fast retry tests. */
const fastSleep = jest.fn(async (_ms: number) => undefined);

describe('installDockingDeps', () => {
  it('darwin happy path: brew install runs and returns installed=true', async () => {
    const { fn, calls } = makeExecStub(['brew --version', 'brew install']);
    const result = await installDockingDeps({
      platform: 'darwin',
      execSyncFn: fn,
      env: {},
    });
    expect(result.installed).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe('brew --version');
    expect(calls[1].cmd).toBe('brew install autodock-vina open-babel');
  });

  it('darwin without brew: returns installed=false with brew in reason', async () => {
    const { fn, calls } = makeExecStub([]); // every cmd throws
    const result = await installDockingDeps({
      platform: 'darwin',
      execSyncFn: fn,
      env: {},
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/brew/);
    // Only the probe was attempted, no actual install command.
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('brew --version');
  });

  it('linux apt happy path: apt-get install runs and returns installed=true', async () => {
    const { fn, calls } = makeExecStub(['apt-get --version', 'sudo apt-get install']);
    const result = await installDockingDeps({
      platform: 'linux',
      execSyncFn: fn,
      env: {},
    });
    expect(result.installed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe('apt-get --version');
    expect(calls[1].cmd).toBe('sudo apt-get install -y autodock-vina openbabel');
  });

  it('linux dnf fallback: apt-get probe fails, dnf install runs', async () => {
    const { fn, calls } = makeExecStub(['dnf --version', 'sudo dnf install']);
    const result = await installDockingDeps({
      platform: 'linux',
      execSyncFn: fn,
      env: {},
    });
    expect(result.installed).toBe(true);
    // apt-get probe + dnf probe + dnf install
    expect(calls).toHaveLength(3);
    expect(calls[0].cmd).toBe('apt-get --version');
    expect(calls[1].cmd).toBe('dnf --version');
    expect(calls[2].cmd).toBe('sudo dnf install -y autodock-vina openbabel');
  });

  it('linux with no package manager: returns reason naming both tried', async () => {
    const { fn } = makeExecStub([]); // every cmd throws
    const result = await installDockingDeps({
      platform: 'linux',
      execSyncFn: fn,
      env: {},
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/apt-get/);
    expect(result.reason).toMatch(/dnf/);
  });

  it('win32: returns installed=false without attempting any install command', async () => {
    const { fn, calls } = makeExecStub(['anything']);
    const result = await installDockingDeps({
      platform: 'win32',
      execSyncFn: fn,
      env: {},
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/Windows not supported/);
    expect(calls).toHaveLength(0);
  });

  it('env override (DISABLE_AUTO_INSTALL_DOCKING=true): no execSync calls', async () => {
    const { fn, calls } = makeExecStub(['brew --version', 'brew install']);
    const result = await installDockingDeps({
      platform: 'darwin',
      execSyncFn: fn,
      env: { DISABLE_AUTO_INSTALL_DOCKING: 'true' },
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/disabled by env/);
    expect(calls).toHaveLength(0);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Bug 1 — apt-get lock retry + branch isolation from dnf
  // ──────────────────────────────────────────────────────────────────────

  it('linux apt lock (exit=100) retries 3x with backoff: 2 locks then ok → installed=true', async () => {
    fastSleep.mockClear();
    const lockStderr = 'E: Could not get lock /var/cache/apt/archives/lock. It is held by process 1213 (apt-get)';
    const { fn, calls } = makeAptStub([
      { exit: 100, stderr: lockStderr },
      { exit: 100, stderr: lockStderr },
      'ok',
    ]);
    const result = await installDockingDeps({
      platform: 'linux',
      execSyncFn: fn,
      env: {},
      sleepFn: fastSleep,
    });
    expect(result.installed).toBe(true);
    // 1 probe + 3 install attempts.
    const installCalls = calls.filter((c) => c.cmd.startsWith('sudo apt-get install'));
    expect(installCalls).toHaveLength(3);
    // 2 sleeps fired (between attempts 1→2 and 2→3); no sleep before attempt 1
    // and none after the successful attempt 3.
    expect(fastSleep).toHaveBeenCalledTimes(2);
    expect(fastSleep).toHaveBeenNthCalledWith(1, 30_000);
    expect(fastSleep).toHaveBeenNthCalledWith(2, 60_000);
    // dnf must NOT be tried (apt-get worked, just retried).
    expect(calls.find((c) => c.cmd.startsWith('dnf'))).toBeUndefined();
  });

  it('linux apt lock (exit=100) exhausts all 3 retries: installed=false with retry-count reason', async () => {
    fastSleep.mockClear();
    const lockStderr = 'E: Could not get lock /var/cache/apt/archives/lock. It is held by process 1213 (apt-get)';
    const { fn, calls } = makeAptStub([
      { exit: 100, stderr: lockStderr },
      { exit: 100, stderr: lockStderr },
      { exit: 100, stderr: lockStderr },
    ]);
    const result = await installDockingDeps({
      platform: 'linux',
      execSyncFn: fn,
      env: {},
      sleepFn: fastSleep,
    });
    expect(result.installed).toBe(false);
    // Reason text harmonized across apt-get + dnf (P10 family: shared
    // installWithLockRetry helper). Both PMs say "lock contention".
    expect(result.reason).toMatch(/after 3 retries \(lock contention\)/);
    expect(result.reason).toContain('1213'); // stderr tail preserved (PID visible)
    // 3 attempts → 2 sleeps between them (no sleep after last failed attempt).
    expect(fastSleep).toHaveBeenCalledTimes(2);
    // dnf NOT tried — apt-get exists, only locked.
    expect(calls.find((c) => c.cmd.startsWith('dnf'))).toBeUndefined();
  });

  it('linux apt non-lock failure (exit=100 ≠ exit=127 unknown pkg): no retry, no dnf fallback', async () => {
    fastSleep.mockClear();
    const { fn, calls } = makeAptStub([
      { exit: 127, stderr: 'E: Unable to locate package autodock-vina' },
    ]);
    const result = await installDockingDeps({
      platform: 'linux',
      execSyncFn: fn,
      env: {},
      sleepFn: fastSleep,
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/apt-get install failed \(exit=127\)/);
    expect(result.reason).toContain('Unable to locate package');
    // ZERO sleeps — bailed on first non-lock exit code.
    expect(fastSleep).not.toHaveBeenCalled();
    // Exactly 1 install attempt — no retry on non-lock failure.
    const installCalls = calls.filter((c) => c.cmd.startsWith('sudo apt-get install'));
    expect(installCalls).toHaveLength(1);
    // dnf NOT tried — apt-get clearly works, just the package install failed.
    expect(calls.find((c) => c.cmd.startsWith('dnf'))).toBeUndefined();
  });

  it('linux apt-get probe fails (ENOENT): dnf fallback still runs as before', async () => {
    fastSleep.mockClear();
    const { fn, calls } = makeExecStub(['dnf --version', 'sudo dnf install']);
    const result = await installDockingDeps({
      platform: 'linux',
      execSyncFn: fn,
      env: {},
      sleepFn: fastSleep,
    });
    expect(result.installed).toBe(true);
    // apt-get probe + dnf probe + dnf install
    expect(calls).toHaveLength(3);
    expect(calls[0].cmd).toBe('apt-get --version');
    expect(calls[1].cmd).toBe('dnf --version');
    expect(calls[2].cmd).toBe('sudo dnf install -y autodock-vina openbabel');
    // No sleeps on a single-attempt success (whether apt OR dnf).
    expect(fastSleep).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // MEDIUM-4 — dnf lock-retry parity (P10 family: shared installWithLockRetry)
  // ──────────────────────────────────────────────────────────────────────

  /**
   * dnf-flavored stub. apt-get probe fails (so we fall through to dnf),
   * dnf probe succeeds, then `sudo dnf install` runs through a programmed
   * sequence of outcomes. Mirrors `makeAptStub` for symmetry.
   */
  type DnfStep = 'ok' | { exit?: number; stderr?: string };
  function makeDnfStub(installSteps: DnfStep[]) {
    const calls: ExecCall[] = [];
    let installCallIdx = 0;
    const fn = jest.fn((cmd: unknown) => {
      const c = String(cmd);
      calls.push({ cmd: c });
      if (c === 'apt-get --version') {
        // Force fallthrough to dnf branch.
        throw new Error('apt-get: not found');
      }
      if (c === 'dnf --version') {
        return Buffer.from('dnf 4.14.0');
      }
      if (c.startsWith('sudo dnf install')) {
        const step = installSteps[installCallIdx++];
        if (step === undefined) {
          throw new Error(`stub: install step ${installCallIdx - 1} not programmed`);
        }
        if (step === 'ok') return Buffer.from('');
        const err = new Error(`Command failed: ${c}`) as Error & {
          status?: number;
          stderr: Buffer;
        };
        if (typeof step.exit === 'number') err.status = step.exit;
        err.stderr = Buffer.from(step.stderr ?? '');
        throw err;
      }
      throw new Error(`stub: command not allowed: ${c}`);
    });
    return { fn: fn as unknown as typeof import('node:child_process').execSync, calls };
  }

  it('linux dnf lock (stderr matches): retries 3x with backoff, 2 locks then ok → installed=true', async () => {
    fastSleep.mockClear();
    // dnf typically returns exit=1 with "Error: Failed to obtain the lock"
    // or "another instance of dnf is running" or "Waiting for process N".
    const lockStderr = 'Error: Failed to obtain the lock /var/cache/dnf/metadata_lock.pid; waiting for process 4242 (dnf) to finish';
    const { fn, calls } = makeDnfStub([
      { exit: 1, stderr: lockStderr },
      { exit: 1, stderr: lockStderr },
      'ok',
    ]);
    const result = await installDockingDeps({
      platform: 'linux',
      execSyncFn: fn,
      env: {},
      sleepFn: fastSleep,
    });
    expect(result.installed).toBe(true);
    // apt-get probe + dnf probe + 3 install attempts = 5
    expect(calls).toHaveLength(5);
    const installCalls = calls.filter((c) => c.cmd.startsWith('sudo dnf install'));
    expect(installCalls).toHaveLength(3);
    // Same backoff schedule as apt-get: 30s, 60s between attempts.
    expect(fastSleep).toHaveBeenCalledTimes(2);
    expect(fastSleep).toHaveBeenNthCalledWith(1, 30_000);
    expect(fastSleep).toHaveBeenNthCalledWith(2, 60_000);
  });

  it('linux dnf lock exhausts all 3 retries: installed=false with lock-contention reason', async () => {
    fastSleep.mockClear();
    const lockStderr = 'Error: Failed to obtain the lock; another instance is running (pid 4242)';
    const { fn } = makeDnfStub([
      { exit: 1, stderr: lockStderr },
      { exit: 1, stderr: lockStderr },
      { exit: 1, stderr: lockStderr },
    ]);
    const result = await installDockingDeps({
      platform: 'linux',
      execSyncFn: fn,
      env: {},
      sleepFn: fastSleep,
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/dnf install failed after 3 retries \(lock contention\)/);
    // Stderr tail preserved so operator can see the lock-holder PID.
    expect(result.reason).toContain('4242');
    // 3 attempts → 2 sleeps between them (no sleep after the last attempt).
    expect(fastSleep).toHaveBeenCalledTimes(2);
  });

  it('linux dnf non-lock failure (unknown pkg, exit=1 with no lock signal): no retry', async () => {
    fastSleep.mockClear();
    const { fn, calls } = makeDnfStub([
      { exit: 1, stderr: 'Error: Unable to find a match: autodock-vina' },
    ]);
    const result = await installDockingDeps({
      platform: 'linux',
      execSyncFn: fn,
      env: {},
      sleepFn: fastSleep,
    });
    expect(result.installed).toBe(false);
    // Reason naming-convention parity with apt: `<pm> install failed (exit=X): <stderr tail>`.
    expect(result.reason).toMatch(/dnf install failed \(exit=1\)/);
    expect(result.reason).toContain('Unable to find a match');
    // ZERO sleeps — bailed immediately on non-lock failure.
    expect(fastSleep).not.toHaveBeenCalled();
    // Exactly 1 install attempt — no retry on non-lock failure.
    const installCalls = calls.filter((c) => c.cmd.startsWith('sudo dnf install'));
    expect(installCalls).toHaveLength(1);
  });

  it('linux dnf absent (probe fails after apt-get also absent): clean no-pm reason, no retry', async () => {
    fastSleep.mockClear();
    const { fn, calls } = makeExecStub([]); // every cmd throws
    const result = await installDockingDeps({
      platform: 'linux',
      execSyncFn: fn,
      env: {},
      sleepFn: fastSleep,
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/no supported package manager found/);
    expect(result.reason).toMatch(/apt-get/);
    expect(result.reason).toMatch(/dnf/);
    // apt-get probe + dnf probe = 2 calls. NO install attempt anywhere.
    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe('apt-get --version');
    expect(calls[1].cmd).toBe('dnf --version');
    expect(fastSleep).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────
// LOW-2 — extractExitCode / extractStderrTail helper micro-tests
//
// These two helpers are small but they are the entire retry-loop trigger
// (lock-detection branches on them). Shape variance across thrown-error
// shapes must be pinned so a future change to one helper can't silently
// flip the retry semantics for apt-get or dnf.
// ──────────────────────────────────────────────────────────────────────

describe('extractExitCode', () => {
  it('returns the numeric status when err.status is a number (e.g. 100 = apt lock)', () => {
    const err = { status: 100 };
    expect(extractExitCode(err)).toBe(100);
  });

  it('returns -1 when err has no .status (e.g. ENOENT thrown synchronously)', () => {
    const err = Object.assign(new Error('spawn dnf ENOENT'), { code: 'ENOENT' });
    expect(extractExitCode(err)).toBe(-1);
  });
});

describe('extractStderrTail', () => {
  it('returns the last maxChars of err.stderr when it is a Buffer', () => {
    const long = 'X'.repeat(600) + 'TAIL_MARKER';
    const err = { stderr: Buffer.from(long) };
    const out = extractStderrTail(err, 500);
    // Last 500 chars only.
    expect(out.length).toBe(500);
    expect(out.endsWith('TAIL_MARKER')).toBe(true);
    // Head Xs should be truncated (we keep tail).
    expect(out.startsWith('X'.repeat(500))).toBe(false);
  });

  it('returns empty string when err.stderr is undefined and there is no .message', () => {
    // Pass a plain object with no stderr and no message to exercise the
    // ultimate fallback branch. extractStderrTail will read .message (also
    // undefined), default to '', then trim → ''.
    const err = {};
    expect(extractStderrTail(err)).toBe('');
  });
});
