/**
 * Bug 12 v2 — on-disk LoRA stack marker (root-cause fix).
 *
 * Live coord log 2026-05-17 UTC showed POD1 caps oscillating every
 * ~3 min between 7 caps (no lora_training/lora_generation) and 9 caps
 * (with both). Each oscillation is a fresh `python -c "import
 * transformers, ..."` spawn from `isLoraStackAvailable()` racing the
 * 60s heartbeat deadline. The marker persists "this venv successfully
 * imported the LoRA stack" across boots so the runtime probe is
 * skipped entirely in steady state.
 *
 * Reviewer MED-1 (post-rework): `installedAt` field was dropped from
 * the marker shape because no code path read it. Marker JSON is now
 * `{ venvPython, transformersVersion? }` only. Spec asserts the
 * parser tolerates legacy markers that still carry `installedAt`
 * (forward compatibility on the read path) and the new write path
 * persists the slimmer shape.
 *
 * Contract under test:
 *   1. `readLoraStackMarker()` returns null when:
 *        a. file is absent
 *        b. file is corrupt JSON
 *        c. file is valid JSON but missing required fields
 *        d. file is valid but `venvPython` field !== current venv path
 *   2. `readLoraStackMarker()` returns the parsed marker when valid + path matches.
 *   3. `writeLoraStackMarker()` writes valid JSON atomically (tmp → rename).
 *   4. `writeLoraStackMarker()` returns false on IO failure (parent unwritable).
 *   5. `deleteLoraStackMarker()` is a no-op when file is missing.
 *   6. `deleteLoraStackMarker()` removes the file when present.
 *   7. Legacy markers carrying `installedAt` parse fine (no breakage).
 *   8. New writes never emit `installedAt`.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// IMPORTANT: SYNAPSEIA_HOME is read at module-load to compute
// LORA_STACK_MARKER. We must set it before importing the module under
// test, then re-import dynamically per test suite.

const TMP_HOME = join(tmpdir(), `syn-test-marker-${process.pid}-${Date.now()}`);

beforeEach(() => {
  // Fresh isolated home per test — guarantees no marker pollution
  // between cases and no interference from a real
  // ~/.synapseia/lora-stack-ok on the dev machine.
  process.env.SYNAPSEIA_HOME = TMP_HOME;
  mkdirSync(TMP_HOME, { recursive: true });
});

afterEach(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* tolerate */ }
  delete process.env.SYNAPSEIA_HOME;
});

async function loadModuleFresh() {
  // python-venv reads SYNAPSEIA_HOME at module evaluation time, so we
  // jest.resetModules() to force a re-eval against the test env home.
  const { jest } = await import('@jest/globals');
  jest.resetModules();
  return await import('../python-venv');
}

describe('python-venv — LoRA stack marker (Bug 12 v2)', () => {
  describe('readLoraStackMarker', () => {
    it('returns null when marker file is absent', async () => {
      const venv = await loadModuleFresh();
      expect(existsSync(venv.LORA_STACK_MARKER)).toBe(false);
      expect(venv.readLoraStackMarker(venv.venvPython())).toBeNull();
    });

    it('returns null when marker contains corrupt JSON', async () => {
      const venv = await loadModuleFresh();
      writeFileSync(venv.LORA_STACK_MARKER, '{not json at all}', 'utf-8');
      expect(venv.readLoraStackMarker(venv.venvPython())).toBeNull();
    });

    it('returns null when marker is valid JSON but missing required fields', async () => {
      const venv = await loadModuleFresh();
      writeFileSync(
        venv.LORA_STACK_MARKER,
        JSON.stringify({ transformersVersion: '4.45.0' /* venvPython missing */ }),
        'utf-8',
      );
      expect(venv.readLoraStackMarker(venv.venvPython())).toBeNull();
    });

    it('returns null when marker venvPython does not match current venv path', async () => {
      const venv = await loadModuleFresh();
      writeFileSync(
        venv.LORA_STACK_MARKER,
        JSON.stringify({
          venvPython: '/some/other/venv/bin/python',
          transformersVersion: '4.45.0',
        }),
        'utf-8',
      );
      expect(venv.readLoraStackMarker(venv.venvPython())).toBeNull();
    });

    it('returns the parsed marker when valid and venvPython matches', async () => {
      const venv = await loadModuleFresh();
      const expected = {
        venvPython: venv.venvPython(),
        transformersVersion: '4.45.0',
      };
      writeFileSync(venv.LORA_STACK_MARKER, JSON.stringify(expected), 'utf-8');
      const marker = venv.readLoraStackMarker(venv.venvPython());
      expect(marker).not.toBeNull();
      expect(marker?.venvPython).toBe(expected.venvPython);
      expect(marker?.transformersVersion).toBe('4.45.0');
    });

    it('tolerates legacy markers carrying the deprecated installedAt field (forward-compat)', async () => {
      // Reviewer MED-1: the field was removed from the write path but
      // operators upgrading from 0.8.60 may still have markers on disk
      // that carry `installedAt`. The parser MUST NOT reject them —
      // forcing re-write would re-spawn the 4-5s cold transformers
      // import on every upgrade, defeating the marker's purpose.
      const venv = await loadModuleFresh();
      writeFileSync(
        venv.LORA_STACK_MARKER,
        JSON.stringify({
          venvPython: venv.venvPython(),
          installedAt: 1_700_000_000_000,
          transformersVersion: '4.45.0',
        }),
        'utf-8',
      );
      const marker = venv.readLoraStackMarker(venv.venvPython());
      expect(marker).not.toBeNull();
      expect(marker?.venvPython).toBe(venv.venvPython());
      expect(marker?.transformersVersion).toBe('4.45.0');
    });
  });

  describe('writeLoraStackMarker', () => {
    it('writes valid JSON atomically and returns true', async () => {
      const venv = await loadModuleFresh();
      const marker = {
        venvPython: venv.venvPython(),
        transformersVersion: '4.45.0',
      };
      const ok = venv.writeLoraStackMarker(marker);
      expect(ok).toBe(true);
      const raw = readFileSync(venv.LORA_STACK_MARKER, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.venvPython).toBe(marker.venvPython);
      expect(parsed.transformersVersion).toBe('4.45.0');
      // Reviewer MED-1: `installedAt` MUST NOT appear in fresh writes.
      // The field was removed from the write path; new markers carry
      // only `venvPython` + optional `transformersVersion`.
      expect(parsed.installedAt).toBeUndefined();
      // tmp file from atomic rename must be cleaned up
      expect(existsSync(`${venv.LORA_STACK_MARKER}.tmp`)).toBe(false);
    });

    it('overwrites an existing marker', async () => {
      const venv = await loadModuleFresh();
      venv.writeLoraStackMarker({
        venvPython: venv.venvPython(),
      });
      const ok = venv.writeLoraStackMarker({
        venvPython: venv.venvPython(),
        transformersVersion: '4.46.0',
      });
      expect(ok).toBe(true);
      const parsed = JSON.parse(readFileSync(venv.LORA_STACK_MARKER, 'utf-8'));
      expect(parsed.transformersVersion).toBe('4.46.0');
    });

    it('round-trips: write then read returns equivalent marker', async () => {
      const venv = await loadModuleFresh();
      const written = {
        venvPython: venv.venvPython(),
        transformersVersion: '4.45.2',
      };
      venv.writeLoraStackMarker(written);
      const read = venv.readLoraStackMarker(venv.venvPython());
      expect(read).toEqual(written);
    });
  });

  describe('failure paths (IO errors)', () => {
    it('writeLoraStackMarker returns false when the parent path is a file (mkdir fails)', async () => {
      const venv = await loadModuleFresh();
      // Replace the parent dir with a regular file so mkdirSync(recursive) throws
      // ENOTDIR. Easier than chmod (which is unreliable as root in CI).
      rmSync(TMP_HOME, { recursive: true, force: true });
      writeFileSync(TMP_HOME, 'not a dir', 'utf-8');
      const ok = venv.writeLoraStackMarker({
        venvPython: venv.venvPython(),
      });
      expect(ok).toBe(false);
      // Cleanup: caller's afterEach rmSync handles both file + dir.
    });

    it('readLoraStackMarker returns null when the marker path is a directory (read throws)', async () => {
      const venv = await loadModuleFresh();
      // Create a directory AT the marker path so readFileSync throws EISDIR.
      mkdirSync(venv.LORA_STACK_MARKER, { recursive: true });
      expect(venv.readLoraStackMarker(venv.venvPython())).toBeNull();
      rmSync(venv.LORA_STACK_MARKER, { recursive: true, force: true });
    });

    it('deleteLoraStackMarker tolerates a marker path that is a non-empty directory', async () => {
      const venv = await loadModuleFresh();
      // unlinkSync on a directory raises EISDIR — deleteLoraStackMarker
      // must swallow it (best-effort cleanup contract).
      mkdirSync(venv.LORA_STACK_MARKER, { recursive: true });
      writeFileSync(join(venv.LORA_STACK_MARKER, 'child'), 'x', 'utf-8');
      expect(() => venv.deleteLoraStackMarker()).not.toThrow();
      rmSync(venv.LORA_STACK_MARKER, { recursive: true, force: true });
    });
  });

  describe('deleteLoraStackMarker', () => {
    it('is a no-op when marker is missing', async () => {
      const venv = await loadModuleFresh();
      expect(existsSync(venv.LORA_STACK_MARKER)).toBe(false);
      // Must not throw
      expect(() => venv.deleteLoraStackMarker()).not.toThrow();
    });

    it('removes the marker file when it exists', async () => {
      const venv = await loadModuleFresh();
      venv.writeLoraStackMarker({
        venvPython: venv.venvPython(),
      });
      expect(existsSync(venv.LORA_STACK_MARKER)).toBe(true);
      venv.deleteLoraStackMarker();
      expect(existsSync(venv.LORA_STACK_MARKER)).toBe(false);
    });

    it('subsequent read after delete returns null', async () => {
      const venv = await loadModuleFresh();
      venv.writeLoraStackMarker({
        venvPython: venv.venvPython(),
      });
      venv.deleteLoraStackMarker();
      expect(venv.readLoraStackMarker(venv.venvPython())).toBeNull();
    });
  });
});
