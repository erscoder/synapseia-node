/**
 * install-deps — `detectVenvPythonMinor` spec (2026-05-22).
 *
 * The torch version + NVIDIA wheel index are keyed on the venv Python
 * minor version. This spec drives the detector with an injected
 * `spawnFn` so no real interpreter is invoked: it must parse the minor
 * from stdout, and fail-CLOSED to `null` (→ proven legacy default at the
 * call site) when the probe errors / produces garbage.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { detectVenvPythonMinor } from '../install-deps';

type SpawnReturn = {
  status: number | null;
  error?: Error;
  stdout: string;
  stderr: string;
};

const fakeSpawn = (ret: Partial<SpawnReturn>) =>
  jest.fn(() => ({
    status: ret.status ?? 0,
    error: ret.error,
    stdout: ret.stdout ?? '',
    stderr: ret.stderr ?? '',
    signal: null,
    output: [],
    pid: 1,
  })) as unknown as typeof import('child_process').spawnSync;

describe('install-deps detectVenvPythonMinor', () => {
  it('parses the minor from stdout (3.13 → 13)', () => {
    const minor = detectVenvPythonMinor('/venv/bin/python', fakeSpawn({ status: 0, stdout: '13\n' }));
    expect(minor).toBe(13);
  });

  it('parses 3.12 → 12', () => {
    const minor = detectVenvPythonMinor('/venv/bin/python', fakeSpawn({ status: 0, stdout: '12' }));
    expect(minor).toBe(12);
  });

  it('non-zero exit → null (fall back to legacy default)', () => {
    const minor = detectVenvPythonMinor('/venv/bin/python', fakeSpawn({ status: 1, stdout: '' }));
    expect(minor).toBeNull();
  });

  it('spawn error → null', () => {
    const minor = detectVenvPythonMinor(
      '/venv/bin/python',
      fakeSpawn({ status: null, error: new Error('ENOENT') }),
    );
    expect(minor).toBeNull();
  });

  it('garbage stdout → null', () => {
    const minor = detectVenvPythonMinor('/venv/bin/python', fakeSpawn({ status: 0, stdout: 'not-a-number' }));
    expect(minor).toBeNull();
  });
});
