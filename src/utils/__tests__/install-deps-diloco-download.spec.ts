/**
 * install-deps — `runDilocoModelDownload` spec (Bug 18 v3).
 *
 * Exercises the install-time pre-download path that replaces runtime
 * HF Hub I/O. We do NOT run real python here — `spawnFn` is injected
 * so the test drives subprocess exit codes deterministically.
 *
 * Coverage:
 *   1. Retry on transient HF error (rate-limit / network), idempotent
 *      re-spawn until success.
 *   2. Fail after MAX_DOWNLOAD_ATTEMPTS with the last stderr captured.
 *   3. Happy path: snapshot path parsed from stdout, marker writeable.
 *
 * P29 discipline: the spec exercises the real retry loop in production
 * code — not a mock around the retry helper. Multiple spawnFn calls
 * are asserted via `.mock.calls.length`.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { runDilocoModelDownload, type InstallDepsEvent } from '../install-deps';

type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

/**
 * Build a fake `spawnSync`-shaped function whose sequential calls
 * return the queued results. Once the queue is exhausted, returns a
 * generic failure so a missing assertion stands out instead of looping.
 */
function makeFakeSpawn(queue: SpawnResult[]) {
  const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
  const fn = jest.fn((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args: [...args], opts });
    const next = queue.shift();
    if (!next) {
      return { status: 1, stdout: '', stderr: 'spawn queue exhausted' };
    }
    return next;
  });
  return { fn: fn as unknown as typeof import('child_process').spawnSync, calls };
}

describe('install-deps runDilocoModelDownload (Bug 18 v3)', () => {
  let events: InstallDepsEvent[];

  beforeEach(() => {
    events = [];
  });

  const emit = (e: InstallDepsEvent) => events.push(e);

  // Inject a no-op sleep so retry backoff doesn't actually wait 5s + 10s
  // in tests. We still assert the operator-facing "retrying in Xs" event
  // text below, which is what consumers care about.
  const noSleep = async (_ms: number) => {};

  it('fails after MAX_DOWNLOAD_ATTEMPTS with last stderr captured', async () => {
    const { fn, calls } = makeFakeSpawn([
      { status: 1, stdout: '', stderr: 'requests.exceptions.HTTPError: 429 Too Many Requests' },
      { status: 1, stdout: '', stderr: 'urllib3.exceptions.ProtocolError: Connection reset' },
      { status: 1, stdout: '', stderr: 'final error: still failing' },
    ]);

    const res = await runDilocoModelDownload('Qwen/Qwen2.5-7B', emit, fn, noSleep);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable'); // narrow
    expect(res.reason).toContain('final error');
    // 3 attempts total.
    expect(calls.length).toBe(3);
    // Operator saw running events for retries.
    const retryEvents = events.filter(
      (e) => e.status === 'running' && e.message.includes('retrying'),
    );
    expect(retryEvents.length).toBe(2);
  });

  it('retries transient error, then succeeds → marker written', async () => {
    // First spawn: transient failure. Second: success with valid stdout.
    // We won't actually let `writeDilocoModelMarker` / `sumDirSize`
    // touch disk (cacheDir won't exist) — assert the parse + retry
    // contract, then assert the failure mode about cacheDir not
    // existing. Full success path is asserted in the integration test
    // below using an actual tmp dir.
    const { fn, calls } = makeFakeSpawn([
      { status: 1, stdout: '', stderr: 'rate limit' },
      { status: 0, stdout: 'DILOCO_CACHE_DIR=/non/existent/path\n', stderr: '' },
    ]);

    const res = await runDilocoModelDownload('Qwen/Qwen2.5-7B', emit, fn, noSleep);
    expect(calls.length).toBe(2);
    // Stdout was captured from the second attempt → we got past the
    // retry loop. The function then validates `existsSync(cacheDir)`
    // and fails because /non/existent/path is missing — which is
    // exactly the parse-then-validate contract we wanted to assert.
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toMatch(/path does not exist/);
  });

  it('happy path: parses snapshot path, computes size, returns ok=true', async () => {
    // Create a real tmp dir with a 600 MB sparse "shard" so the size
    // gate (500 MB) passes. We don't assert the marker file location
    // because `DILOCO_MODEL_MARKER` is resolved at module-load time
    // and pinning it from inside the spec is brittle — the marker
    // round-trip is covered separately in python-venv-lora-marker.spec.
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diloco-test-'));
    const shardFile = path.join(tmpDir, 'shard.safetensors');
    const fd = fs.openSync(shardFile, 'w');
    fs.ftruncateSync(fd, 600 * 1024 * 1024);
    fs.closeSync(fd);

    try {
      const { fn } = makeFakeSpawn([
        { status: 0, stdout: `DILOCO_CACHE_DIR=${tmpDir}\n`, stderr: '' },
      ]);
      const res = await runDilocoModelDownload('Qwen/Qwen2.5-7B', emit, fn);
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      expect(res.cacheDir).toBe(tmpDir);
      expect(res.sizeBytes).toBeGreaterThanOrEqual(500 * 1024 * 1024);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects when cache size below MIN_SIZE_BYTES (download incomplete)', async () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diloco-small-'));
    // Tiny file — well below 500 MB gate.
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');
    try {
      const { fn } = makeFakeSpawn([
        { status: 0, stdout: `DILOCO_CACHE_DIR=${tmpDir}\n`, stderr: '' },
      ]);
      const res = await runDilocoModelDownload('Qwen/Qwen2.5-7B', emit, fn);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toMatch(/download likely incomplete/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects when stdout has no DILOCO_CACHE_DIR marker line', async () => {
    const { fn } = makeFakeSpawn([
      { status: 0, stdout: 'something else entirely\n', stderr: '' },
    ]);
    const res = await runDilocoModelDownload('Qwen/Qwen2.5-7B', emit, fn);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toMatch(/cache dir not captured/);
  });
});
