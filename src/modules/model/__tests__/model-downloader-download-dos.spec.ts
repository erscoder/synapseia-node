/**
 * F-node-DoS (MED) regression — `downloadAdapter` fetch hardening.
 *
 * Pre-fix the adapter download had two unbounded resources:
 *   1. `fetch(url)` with NO timeout — a slow-loris / black-holed server could
 *      pin the trainer forever.
 *   2. `response.arrayBuffer()` buffered the WHOLE body before any size check,
 *      so a hostile URL (or a lying/absent Content-Length) could OOM the node.
 *
 * The fix adds `AbortSignal.timeout(...)` to the fetch, a Content-Length
 * pre-check against a hard cap, and a streamed read with a running byte
 * counter that aborts past the cap. These tests assert the BEHAVIOR:
 *   - the fetch is called with a timeout signal,
 *   - a body that exceeds the cap (via header OR via stream, with a
 *     missing/lying Content-Length) is rejected with AdapterIntegrityError
 *     and never written to disk,
 *   - a timeout AbortError surfaces as a fail-closed AdapterIntegrityError,
 *   - the happy path (small streamed body, sha matches) still works.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { ModelDownloaderHelper, AdapterIntegrityError } from '../model-downloader';

// A valid 64-hex sha256 for arbitrary bytes.
function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// Build a fake fetch Response whose body streams the given chunks via a
// WHATWG-style ReadableStream reader. `contentLength` is optional (undefined =
// header absent; a wrong number = lying server).
function streamingResponse(
  chunks: Uint8Array[],
  opts: { ok?: boolean; status?: number; contentLength?: number } = {},
): Response {
  let i = 0;
  const reader = {
    read: async () => {
      if (i < chunks.length) return { done: false, value: chunks[i++] };
      return { done: true, value: undefined };
    },
    cancel: jest.fn(async () => {}),
  };
  const headers = {
    get: (k: string) =>
      k.toLowerCase() === 'content-length' && opts.contentLength !== undefined
        ? String(opts.contentLength)
        : null,
  };
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers,
    body: { getReader: () => reader },
  } as unknown as Response;
}

const originalFetch = global.fetch;
const originalTimeout = AbortSignal.timeout;

describe('F-node-DoS — downloadAdapter fetch hardening', () => {
  let tmpDir: string;
  let timeoutCalls: number[];

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'syn-dl-dos-'));
    timeoutCalls = [];
    // Capture the timeout budget passed to AbortSignal.timeout without
    // actually arming a 5-minute timer.
    (AbortSignal as any).timeout = (ms: number) => {
      timeoutCalls.push(ms);
      return new AbortController().signal;
    };
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
    (AbortSignal as any).timeout = originalTimeout;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('passes an AbortSignal timeout to fetch', async () => {
    const helper = new ModelDownloaderHelper();
    const payload = Buffer.from('lora-weights');
    (global as any).fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      // The fix must thread a signal into the fetch options.
      expect(init?.signal).toBeDefined();
      return streamingResponse([new Uint8Array(payload)]);
    });

    await helper.downloadAdapter('https://host/adapter', tmpDir, sha256Hex(payload));

    expect((global.fetch as any)).toHaveBeenCalledTimes(1);
    // A single, positive timeout budget was requested.
    expect(timeoutCalls).toHaveLength(1);
    expect(timeoutCalls[0]).toBeGreaterThan(0);
  });

  it('streams a small body and persists it when sha256 matches', async () => {
    const helper = new ModelDownloaderHelper();
    const payload = Buffer.from('the-real-adapter-bytes');
    (global as any).fetch = jest.fn(async () =>
      streamingResponse([new Uint8Array(payload.subarray(0, 5)), new Uint8Array(payload.subarray(5))]),
    );

    await helper.downloadAdapter('https://host/a', tmpDir, sha256Hex(payload));

    // adapter_weights.safetensors must exist after a verified download.
    expect(existsSync(path.join(tmpDir, 'adapter_weights.safetensors'))).toBe(true);
  });

  it('rejects early on an oversized Content-Length without streaming the body', async () => {
    const helper = new ModelDownloaderHelper();
    const reader = { read: jest.fn(), cancel: jest.fn() };
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(50 * 1024 * 1024 * 1024) }, // 50 GiB advertised
      body: { getReader: () => reader },
    }) as unknown as Response);

    await expect(
      helper.downloadAdapter('https://host/huge', tmpDir, 'a'.repeat(64)),
    ).rejects.toBeInstanceOf(AdapterIntegrityError);
    await expect(
      helper.downloadAdapter('https://host/huge', tmpDir, 'a'.repeat(64)),
    ).rejects.toMatchObject({ reason: 'download-failed' });

    // Header-only rejection: the body stream is never read.
    expect(reader.read).not.toHaveBeenCalled();
    // Nothing persisted.
    expect(existsSync(path.join(tmpDir, 'adapter_weights.safetensors'))).toBe(false);
  });

  it('aborts mid-stream when cumulative bytes exceed the cap (lying/absent Content-Length)', async () => {
    const helper = new ModelDownloaderHelper();
    // Drive the streamed byte-counter past the production cap WITHOUT allocating
    // gigabytes: a chunk that merely *reports* a 3 GiB byteLength. The
    // Content-Length header is absent (lying server), so the header pre-check is
    // bypassed and the streamed counter is the sole guard under test.
    const fakeHugeChunk = { byteLength: 3 * 1024 * 1024 * 1024 } as unknown as Uint8Array;
    const cancel = jest.fn(async () => {});
    let read = 0;
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null }, // Content-Length ABSENT (lying server)
      body: {
        getReader: () => ({
          read: async () => {
            if (read++ === 0) return { done: false, value: fakeHugeChunk };
            return { done: true, value: undefined };
          },
          cancel,
        }),
      },
    }) as unknown as Response);

    await expect(
      helper.downloadAdapter('https://host/lying', tmpDir, 'b'.repeat(64)),
    ).rejects.toMatchObject({ name: 'AdapterIntegrityError', reason: 'download-failed' });

    // The stream was torn down once the running counter passed the cap.
    expect(cancel).toHaveBeenCalled();
    expect(existsSync(path.join(tmpDir, 'adapter_weights.safetensors'))).toBe(false);
  });

  it('surfaces a fetch timeout AbortError as a fail-closed AdapterIntegrityError', async () => {
    const helper = new ModelDownloaderHelper();
    (global as any).fetch = jest.fn(async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    });

    await expect(
      helper.downloadAdapter('https://host/slow', tmpDir, 'c'.repeat(64)),
    ).rejects.toMatchObject({ name: 'AdapterIntegrityError', reason: 'download-failed' });

    // No partial artefact left behind.
    expect(existsSync(path.join(tmpDir, 'adapter_weights.safetensors'))).toBe(false);
    // The cache dir may have been created (mkdir before fetch) but holds no weights.
    if (existsSync(tmpDir)) {
      expect(readdirSync(tmpDir)).not.toContain('adapter_weights.safetensors');
    }
  });

  it('still fails closed on sha256 mismatch after a streamed download', async () => {
    const helper = new ModelDownloaderHelper();
    const payload = Buffer.from('honest-bytes');
    (global as any).fetch = jest.fn(async () => streamingResponse([new Uint8Array(payload)]));

    await expect(
      // expected hash deliberately wrong
      helper.downloadAdapter('https://host/a', tmpDir, 'd'.repeat(64)),
    ).rejects.toMatchObject({ name: 'AdapterIntegrityError', reason: 'sha256-mismatch' });

    expect(existsSync(path.join(tmpDir, 'adapter_weights.safetensors'))).toBe(false);
  });
});
