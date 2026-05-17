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
  it('darwin happy path (arm64): brew + curl mac_aarch64 Vina + chmod + version probe → installed=true', async () => {
    // 0.8.55+ split: autodock-vina is NOT in homebrew-core, so the installer
    // brews open-babel and downloads the Vina binary from the AutoDock-Vina
    // GitHub release. Bug fixed 2026-05-17: prior template emitted
    // `vina_<ver>_macos_arm64` which 404s; real asset is `mac_aarch64`.
    // Stub accepts: brew probe + brew install + curl + chmod + version probe.
    const origArch = process.arch;
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    try {
      const { fn, calls } = makeExecStub([
        'brew --version',
        'brew install',
        'curl ',
        'chmod ',
        '"', // version probe is `"${vinaBinPath}" --version`
      ]);
      const result = await installDockingDeps({
        platform: 'darwin',
        execSyncFn: fn,
        env: {},
      });
      expect(result.installed).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      // Either 2 calls (Vina already present + executable) or 5 calls
      // (brew probe + brew install + curl + chmod + version probe).
      expect(calls[0].cmd).toBe('brew --version');
      expect(calls[1].cmd).toBe('brew install open-babel');
      if (calls.length > 2) {
        expect(calls.length).toBe(5);
        // Regression guard against P28: literal substring of GH release
        // naming convention. Any future drift (mac→macos, aarch64→arm64,
        // version bump without updating template) trips this assertion.
        expect(calls[2].cmd).toContain('vina_1.2.5_mac_aarch64');
        expect(calls[2].cmd).toMatch(/^curl -sLf -o ".*\/\.synapseia\/bin\/vina" "https:\/\/github\.com\/ccsb-scripps\/AutoDock-Vina\/releases\/download\/v1\.2\.5\/vina_1\.2\.5_mac_aarch64"$/);
        expect(calls[3].cmd).toMatch(/^chmod \+x ".*\/\.synapseia\/bin\/vina"$/);
        // Post-download verify probe: vina --version. Catches HTML-404
        // decoy pages that downloaded + chmod'd but aren't Mach-O.
        expect(calls[4].cmd).toMatch(/^".*\/\.synapseia\/bin\/vina" --version$/);
      }
    } finally {
      Object.defineProperty(process, 'arch', { value: origArch, configurable: true });
    }
  });

  it('darwin happy path (x64): curl asset uses mac_x86_64 segment', async () => {
    // Symmetric to arm64 test — assert the x86_64 arch mapping path. Same
    // GH release naming convention (`mac_x86_64`), no `macos_` prefix.
    const origArch = process.arch;
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    try {
      const { fn, calls } = makeExecStub([
        'brew --version',
        'brew install',
        'curl ',
        'chmod ',
        '"',
      ]);
      const result = await installDockingDeps({
        platform: 'darwin',
        execSyncFn: fn,
        env: {},
      });
      expect(result.installed).toBe(true);
      if (calls.length > 2) {
        expect(calls[2].cmd).toContain('vina_1.2.5_mac_x86_64');
        // Negative guard: stale 0.8.55-0.8.65 literal must not reappear.
        expect(calls[2].cmd).not.toContain('macos_');
        expect(calls[2].cmd).not.toContain('mac_arm64');
      }
    } finally {
      Object.defineProperty(process, 'arch', { value: origArch, configurable: true });
    }
  });

  it('darwin: vina --version probe failure → installed=false with probe reason', async () => {
    // P29 — exercise the real spawn-call path. The post-download verify
    // catches the case where curl-with-`-f` somehow returned a non-Mach-O
    // file (mirror outage HTML, captive portal, partial write). chmod
    // succeeds on garbage; only `vina --version` reveals the corruption.
    const origArch = process.arch;
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    try {
      // Stub accepts curl + chmod but throws on the version probe.
      const calls: ExecCall[] = [];
      const fn = jest.fn((cmd: unknown) => {
        const c = String(cmd);
        calls.push({ cmd: c });
        if (c === 'brew --version') return Buffer.from('');
        if (c.startsWith('brew install')) return Buffer.from('');
        if (c.startsWith('curl ')) return Buffer.from('');
        if (c.startsWith('chmod ')) return Buffer.from('');
        if (/\.synapseia\/bin\/vina" --version$/.test(c)) {
          throw new Error('exec format error');
        }
        throw new Error(`stub: unexpected cmd: ${c}`);
      }) as unknown as typeof import('node:child_process').execSync;
      const result = await installDockingDeps({
        platform: 'darwin',
        execSyncFn: fn,
        env: {},
      });
      // Only assert when Vina was actually downloaded (binary absent in test env).
      // If $HOME/.synapseia/bin/vina happens to exist, vinaReady=true and we
      // never hit the probe — that's the early-skip branch, not under test.
      if (calls.some((c) => c.cmd.startsWith('curl '))) {
        expect(result.installed).toBe(false);
        expect(result.reason).toMatch(/Vina downloaded but --version probe failed/);
        expect(result.reason).toMatch(/exec format error/);
      }
    } finally {
      Object.defineProperty(process, 'arch', { value: origArch, configurable: true });
    }
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
