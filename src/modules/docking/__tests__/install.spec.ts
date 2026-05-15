/**
 * Tests for the OS-aware docking dependency auto-installer.
 *
 * The installer is exercised via injected stubs (execSyncFn / platform / env)
 * so we never actually shell out to a package manager. Each test verifies the
 * exact command(s) that would be issued and the {installed, reason} contract.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { installDockingDeps } from '../install';

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
});
