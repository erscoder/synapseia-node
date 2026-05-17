/**
 * diloco_train.py — Bug 18 v3 fail-fast spec.
 *
 * Verifies the Python-side contract that the runtime is LOCAL-ONLY:
 *   1. Missing marker → `_resolve_local_snapshot` raises with the
 *      operator-actionable "Run `syn install-deps` first" hint.
 *   2. Stale marker (wrong modelId) → same fail-fast.
 *   3. Marker pointing to non-existent cacheDir → same fail-fast.
 *
 * We exercise this by spawning `python3 -c '...'` and importing the
 * function from the script. That way the assertions track the actual
 * file content rather than re-implementing the logic in JS.
 *
 * If python3 is not on PATH (CI without python), the suite is skipped
 * via a guard rather than failing — install-deps installs python3
 * before any DiLoCo path can run in production.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolve } from 'path';

const PY_SCRIPT = resolve(__dirname, '../../../../scripts/diloco_train.py');

function pythonAvailable(): boolean {
  const r = spawnSync('python3', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * Spawn python3 with an inline script that imports `_resolve_local_snapshot`
 * from `diloco_train.py` and prints exception text (or "OK:<path>") so
 * we can assert against it.
 */
function callResolve(modelId: string, synHome: string): { code: number; stdout: string; stderr: string } {
  const py = [
    'import sys, runpy, importlib.util',
    `spec = importlib.util.spec_from_file_location("diloco_train", ${JSON.stringify(PY_SCRIPT)})`,
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'try:',
    `    path = mod._resolve_local_snapshot(${JSON.stringify(modelId)})`,
    '    print("OK:" + path)',
    'except RuntimeError as e:',
    '    print("ERR:" + str(e))',
    '    sys.exit(2)',
  ].join('\n');
  const r = spawnSync('python3', ['-c', py], {
    encoding: 'utf-8',
    env: { ...process.env, SYNAPSEIA_HOME: synHome },
  });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString(),
  };
}

describe('diloco_train.py _resolve_local_snapshot (Bug 18 v3)', () => {
  let skip = false;

  beforeAll(() => {
    if (!pythonAvailable()) {
      // eslint-disable-next-line no-console
      console.warn('python3 not on PATH — skipping diloco_train.py specs');
      skip = true;
    }
  });

  it('fails fast with install-deps hint when marker is absent', () => {
    if (skip) return;
    const synHome = mkdtempSync(join(tmpdir(), 'syn-no-marker-'));
    try {
      const r = callResolve('Qwen/Qwen2.5-7B', synHome);
      expect(r.code).toBe(2);
      expect(r.stdout).toMatch(/ERR:/);
      expect(r.stdout).toMatch(/Run `syn install-deps`/);
      expect(r.stdout).toMatch(/not cached locally/);
    } finally {
      rmSync(synHome, { recursive: true, force: true });
    }
  });

  it('fails fast when marker is for a different modelId', () => {
    if (skip) return;
    const synHome = mkdtempSync(join(tmpdir(), 'syn-wrong-id-'));
    try {
      writeFileSync(
        join(synHome, 'diloco-model-ok'),
        JSON.stringify({ modelId: 'meta-llama/Llama-3-8B', cacheDir: '/tmp/somewhere' }),
      );
      const r = callResolve('Qwen/Qwen2.5-7B', synHome);
      expect(r.code).toBe(2);
      expect(r.stdout).toMatch(/marker is for modelId='meta-llama\/Llama-3-8B'/);
    } finally {
      rmSync(synHome, { recursive: true, force: true });
    }
  });

  it('fails fast when marker points to a cacheDir that does not exist', () => {
    if (skip) return;
    const synHome = mkdtempSync(join(tmpdir(), 'syn-bad-cache-'));
    try {
      writeFileSync(
        join(synHome, 'diloco-model-ok'),
        JSON.stringify({
          modelId: 'Qwen/Qwen2.5-7B',
          cacheDir: '/definitely/does/not/exist/anywhere',
        }),
      );
      const r = callResolve('Qwen/Qwen2.5-7B', synHome);
      expect(r.code).toBe(2);
      expect(r.stdout).toMatch(/does not exist on disk/);
    } finally {
      rmSync(synHome, { recursive: true, force: true });
    }
  });

  it('returns the snapshot path when marker is valid and cacheDir exists', () => {
    if (skip) return;
    const synHome = mkdtempSync(join(tmpdir(), 'syn-ok-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'syn-cache-'));
    try {
      writeFileSync(
        join(synHome, 'diloco-model-ok'),
        JSON.stringify({
          modelId: 'Qwen/Qwen2.5-7B',
          cacheDir,
        }),
      );
      const r = callResolve('Qwen/Qwen2.5-7B', synHome);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(`OK:${cacheDir}`);
    } finally {
      rmSync(synHome, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('fails fast when marker file is corrupt JSON', () => {
    if (skip) return;
    const synHome = mkdtempSync(join(tmpdir(), 'syn-corrupt-'));
    try {
      writeFileSync(join(synHome, 'diloco-model-ok'), 'not valid json {{{');
      const r = callResolve('Qwen/Qwen2.5-7B', synHome);
      expect(r.code).toBe(2);
      expect(r.stdout).toMatch(/marker exists but is unreadable/);
    } finally {
      rmSync(synHome, { recursive: true, force: true });
    }
  });
});
