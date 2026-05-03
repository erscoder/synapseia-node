/**
 * ActiveModelSubscriber — comprehensive spec (Phase 4 mutation coverage).
 *
 * Covers every tick() return state, the swap-hook contract, the
 * sha-verify fail-closed paths, manifest signature verification with a
 * real Ed25519 keypair, env-gated strict/dev modes, and the
 * download-skip-on-cache path.
 *
 * `fetch` and `fs` are stubbed per test; crypto stays real so the
 * Ed25519 contract is exercised end-to-end.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import { ActiveModelSubscriber } from '../active-model-subscriber';

// ── real Ed25519 keypair for the coord-signed manifest ───────────────────
const keypair = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { format: 'der', type: 'spki' },
  privateKeyEncoding: { format: 'der', type: 'pkcs8' },
});
const COORD_PUB_B64 = (keypair.publicKey as Buffer).toString('base64');

function signManifest(body: Buffer): string {
  const keyObj = crypto.createPrivateKey({
    key: keypair.privateKey as Buffer, format: 'der', type: 'pkcs8',
  });
  return crypto.sign(null, body, keyObj).toString('base64');
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── mock serving client ───────────────────────────────────────────────────
function makeServing() {
  return { setActiveVersion: jest.fn(), getActiveVersion: jest.fn(() => null) } as any;
}

// ── fetch helper ──────────────────────────────────────────────────────────
function okResp(payload: any, type: 'json' | 'buffer' = 'json'): any {
  if (type === 'json') {
    const bodyStr = JSON.stringify(payload);
    return { ok: true, status: 200, json: async () => payload, text: async () => bodyStr, arrayBuffer: async () => Buffer.from(bodyStr) };
  }
  return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => payload };
}
function failResp(code: number): any {
  return { ok: false, status: code, json: async () => ({}), text: async () => '{}', arrayBuffer: async () => Buffer.from('') };
}

// ── env + fs scratch ──────────────────────────────────────────────────────
const savedEnv = { ...process.env };
let scratch: string;
let realFetch: typeof global.fetch;

beforeEach(() => {
  process.env = { ...savedEnv };
  delete process.env.COORDINATOR_URL;
  delete process.env.COORDINATOR_PUBLIC_KEY_BASE64;
  delete process.env.SYNAPSEIA_REQUIRE_SIGNED_MANIFEST;
  delete process.env.SYNAPSEIA_ADAPTER_CACHE_DIR;
  delete process.env.MODEL_POLL_INTERVAL_MS;
  delete process.env.MODEL_SUBSCRIBER_DISABLED;

  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ams-spec-'));
  process.env.SYNAPSEIA_ADAPTER_CACHE_DIR = scratch;
  realFetch = global.fetch;
  (global as any).fetch = jest.fn();
});
afterEach(() => {
  (global as any).fetch = realFetch;
  process.env = { ...savedEnv };
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
});

// ── tick() state machine ──────────────────────────────────────────────────
describe('ActiveModelSubscriber.tick — state transitions', () => {
  it('returns "no-active" when /models/active fetch throws', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('net'));
    const sub = new ActiveModelSubscriber(makeServing());
    expect(await sub.tick()).toBe('no-active');
  });

  it('returns "no-active" when /models/active returns non-ok', async () => {
    (global.fetch as any).mockResolvedValueOnce(failResp(500));
    const sub = new ActiveModelSubscriber(makeServing());
    expect(await sub.tick()).toBe('no-active');
  });

  it('returns "no-active" when body is null', async () => {
    (global.fetch as any).mockResolvedValueOnce(okResp(null));
    expect(await new ActiveModelSubscriber(makeServing()).tick()).toBe('no-active');
  });

  it('returns "no-active" when body has no modelId', async () => {
    (global.fetch as any).mockResolvedValueOnce(okResp({ version: 1 }));
    expect(await new ActiveModelSubscriber(makeServing()).tick()).toBe('no-active');
  });

  it('returns "unchanged" when active modelId matches current', async () => {
    const sub = new ActiveModelSubscriber(makeServing());
    (sub as any).currentModelId = 'same-id';
    (global.fetch as any).mockResolvedValueOnce(okResp({
      modelId: 'same-id', version: 1, generation: 0, sha256: 'x', bucketUrl: 'http://b', manifestSignature: 'sig',
    }));
    expect(await sub.tick()).toBe('unchanged');
  });

  it('returns "download-failed" when adapter fetch HTTP fails', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce(okResp({
        modelId: 'm1', version: 1, generation: 0,
        sha256: 'abc', bucketUrl: 'http://adapter', manifestSignature: 'sig',
      }))
      .mockResolvedValueOnce(failResp(404));
    expect(await new ActiveModelSubscriber(makeServing()).tick()).toBe('download-failed');
  });

  it('returns "verify-failed" on sha256 mismatch after download', async () => {
    const realBytes = Buffer.from('real-adapter-bytes');
    (global.fetch as any)
      .mockResolvedValueOnce(okResp({
        modelId: 'm1', version: 1, generation: 0,
        sha256: 'DIFFERENT', bucketUrl: 'http://adapter', manifestSignature: 'sig',
      }))
      .mockResolvedValueOnce(okResp(realBytes, 'buffer'));
    expect(await new ActiveModelSubscriber(makeServing()).tick()).toBe('verify-failed');
  });

  it('returns "verify-failed" when manifest signature is missing in strict mode', async () => {
    process.env.COORDINATOR_PUBLIC_KEY_BASE64 = COORD_PUB_B64;
    const adapterBytes = Buffer.from('x');
    const activeSha = sha256(adapterBytes);
    (global.fetch as any)
      .mockResolvedValueOnce(okResp({
        modelId: 'm1', version: 1, generation: 0,
        sha256: activeSha, bucketUrl: 'http://host/adapter.safetensors',
        manifestSignature: 'dev-unsigned',
      }))
      .mockResolvedValueOnce(okResp(adapterBytes, 'buffer'));
    expect(await new ActiveModelSubscriber(makeServing()).tick()).toBe('verify-failed');
  });

  it('returns "verify-failed" when COORDINATOR_PUBLIC_KEY_BASE64 missing and strict mode on', async () => {
    process.env.SYNAPSEIA_REQUIRE_SIGNED_MANIFEST = 'true';
    // No COORDINATOR_PUBLIC_KEY_BASE64 set.
    const adapterBytes = Buffer.from('x');
    (global.fetch as any)
      .mockResolvedValueOnce(okResp({
        modelId: 'm1', version: 1, generation: 0,
        sha256: sha256(adapterBytes), bucketUrl: 'http://h/adapter.safetensors',
        manifestSignature: 'sig',
      }))
      .mockResolvedValueOnce(okResp(adapterBytes, 'buffer'));
    expect(await new ActiveModelSubscriber(makeServing()).tick()).toBe('verify-failed');
  });

  it('dev mode (no pubkey, no strict) skips manifest verification and proceeds', async () => {
    // No COORDINATOR_PUBLIC_KEY_BASE64, no strict flag.
    const adapterBytes = Buffer.from('x');
    const serving = makeServing();
    const sub = new ActiveModelSubscriber(serving);
    sub.setSwapHook(async () => undefined);
    (global.fetch as any)
      .mockResolvedValueOnce(okResp({
        modelId: 'm-dev', version: 1, generation: 0,
        sha256: sha256(adapterBytes), bucketUrl: 'http://h/adapter.safetensors',
        manifestSignature: 'irrelevant',
      }))
      .mockResolvedValueOnce(okResp(adapterBytes, 'buffer'));
    expect(await sub.tick()).toBe('swapped');
    expect(serving.setActiveVersion).toHaveBeenCalledWith('m-dev');
  });

  it('returns "download-failed" when no swap hook registered', async () => {
    process.env.COORDINATOR_PUBLIC_KEY_BASE64 = COORD_PUB_B64;
    const adapterBytes = Buffer.from('abc');
    const manifestBody = Buffer.from(JSON.stringify({
      modelId: 'm1', sha256: sha256(adapterBytes), bucketUrl: 'http://h/adapter.safetensors',
    }));
    const manifestSig = signManifest(manifestBody);
    (global.fetch as any)
      .mockResolvedValueOnce(okResp({
        modelId: 'm1', version: 1, generation: 0,
        sha256: sha256(adapterBytes), bucketUrl: 'http://h/adapter.safetensors',
        manifestSignature: manifestSig,
      }))
      .mockResolvedValueOnce(okResp(adapterBytes, 'buffer'))
      .mockResolvedValueOnce(okResp(JSON.parse(manifestBody.toString('utf8'))));
    // Patch manifest fetch: the service reads raw bytes so override.
    (global.fetch as any).mockReset();
    (global.fetch as any)
      .mockResolvedValueOnce(okResp({
        modelId: 'm1', version: 1, generation: 0,
        sha256: sha256(adapterBytes), bucketUrl: 'http://h/adapter.safetensors',
        manifestSignature: manifestSig,
      }))
      .mockResolvedValueOnce(okResp(adapterBytes, 'buffer'))
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => manifestBody });
    // No swap hook → download-failed.
    expect(await new ActiveModelSubscriber(makeServing()).tick()).toBe('download-failed');
  });

  it('returns "swapped" on full happy path with signed manifest', async () => {
    process.env.COORDINATOR_PUBLIC_KEY_BASE64 = COORD_PUB_B64;
    const adapterBytes = Buffer.from('adapter!');
    const manifestBody = Buffer.from(JSON.stringify({
      modelId: 'm-happy', sha256: sha256(adapterBytes),
      bucketUrl: 'http://h/adapter.safetensors',
    }));
    const manifestSig = signManifest(manifestBody);
    (global.fetch as any)
      .mockResolvedValueOnce(okResp({
        modelId: 'm-happy', version: 1, generation: 0,
        sha256: sha256(adapterBytes), bucketUrl: 'http://h/adapter.safetensors',
        manifestSignature: manifestSig,
      }))
      .mockResolvedValueOnce(okResp(adapterBytes, 'buffer'))
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => manifestBody });
    const serving = makeServing();
    const sub = new ActiveModelSubscriber(serving);
    const hook = jest.fn(async () => undefined);
    sub.setSwapHook(hook as any);
    expect(await sub.tick()).toBe('swapped');
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'm-happy' }));
    expect(serving.setActiveVersion).toHaveBeenCalledWith('m-happy');
  });

  it('returns "download-failed" when swap hook itself throws', async () => {
    const adapterBytes = Buffer.from('x');
    (global.fetch as any)
      .mockResolvedValueOnce(okResp({
        modelId: 'm-err', version: 1, generation: 0,
        sha256: sha256(adapterBytes), bucketUrl: 'http://h/adapter.safetensors',
        manifestSignature: 'sig',
      }))
      .mockResolvedValueOnce(okResp(adapterBytes, 'buffer'));
    const serving = makeServing();
    const sub = new ActiveModelSubscriber(serving);
    sub.setSwapHook((async () => { throw new Error('hook-boom'); }) as any);
    expect(await sub.tick()).toBe('download-failed');
    expect(serving.setActiveVersion).not.toHaveBeenCalled();
  });

  it('returns "verify-failed" when manifest modelId mismatches active', async () => {
    process.env.COORDINATOR_PUBLIC_KEY_BASE64 = COORD_PUB_B64;
    const adapterBytes = Buffer.from('z');
    const manifestBody = Buffer.from(JSON.stringify({
      modelId: 'WRONG', sha256: sha256(adapterBytes),
      bucketUrl: 'http://h/adapter.safetensors',
    }));
    const manifestSig = signManifest(manifestBody);
    (global.fetch as any)
      .mockResolvedValueOnce(okResp({
        modelId: 'm-mm', version: 1, generation: 0,
        sha256: sha256(adapterBytes), bucketUrl: 'http://h/adapter.safetensors',
        manifestSignature: manifestSig,
      }))
      .mockResolvedValueOnce(okResp(adapterBytes, 'buffer'))
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => manifestBody });
    const sub = new ActiveModelSubscriber(makeServing());
    sub.setSwapHook(async () => undefined);
    expect(await sub.tick()).toBe('verify-failed');
  });

  it('returns "verify-failed" when manifest signature is cryptographically invalid', async () => {
    process.env.COORDINATOR_PUBLIC_KEY_BASE64 = COORD_PUB_B64;
    const adapterBytes = Buffer.from('z');
    const manifestBody = Buffer.from(JSON.stringify({
      modelId: 'm-badsig', sha256: sha256(adapterBytes),
      bucketUrl: 'http://h/adapter.safetensors',
    }));
    // Sig generated against DIFFERENT body → invalid.
    const otherBody = Buffer.from('{"attacker":true}');
    const invalidSig = signManifest(otherBody);
    (global.fetch as any)
      .mockResolvedValueOnce(okResp({
        modelId: 'm-badsig', version: 1, generation: 0,
        sha256: sha256(adapterBytes), bucketUrl: 'http://h/adapter.safetensors',
        manifestSignature: invalidSig,
      }))
      .mockResolvedValueOnce(okResp(adapterBytes, 'buffer'))
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => manifestBody });
    const sub = new ActiveModelSubscriber(makeServing());
    sub.setSwapHook(async () => undefined);
    expect(await sub.tick()).toBe('verify-failed');
  });

  it('returns "verify-failed" when manifest fetch HTTP fails', async () => {
    process.env.COORDINATOR_PUBLIC_KEY_BASE64 = COORD_PUB_B64;
    const adapterBytes = Buffer.from('z');
    (global.fetch as any)
      .mockResolvedValueOnce(okResp({
        modelId: 'm', version: 1, generation: 0,
        sha256: sha256(adapterBytes), bucketUrl: 'http://h/adapter.safetensors',
        manifestSignature: 'sig',
      }))
      .mockResolvedValueOnce(okResp(adapterBytes, 'buffer'))
      .mockResolvedValueOnce({ ok: false, status: 404, arrayBuffer: async () => Buffer.from('') });
    const sub = new ActiveModelSubscriber(makeServing());
    sub.setSwapHook(async () => undefined);
    expect(await sub.tick()).toBe('verify-failed');
  });
});

// ── Download cache skip ───────────────────────────────────────────────────
describe('ActiveModelSubscriber.downloadAdapter', () => {
  it('skips download when cached file already has expected sha256', async () => {
    const bytes = Buffer.from('cached');
    const targetSha = sha256(bytes);
    const cacheDir = scratch;
    const targetPath = path.join(cacheDir, 'm_cached.safetensors');
    fs.writeFileSync(targetPath, bytes);

    (global.fetch as any).mockResolvedValueOnce(okResp({
      modelId: 'm:cached', version: 1, generation: 0,
      sha256: targetSha, bucketUrl: 'http://adapter',
      manifestSignature: 'sig',
    }));
    const sub = new ActiveModelSubscriber(makeServing());
    sub.setSwapHook(async () => undefined);
    await sub.tick(); // Don't care about swap path — assert the download fetch was NOT called.
    // Only one fetch call total (to /models/active) — adapter wasn't fetched.
    const adapterCalls = (global.fetch as any).mock.calls.filter((c: any[]) => String(c[0]) === 'http://adapter');
    expect(adapterCalls.length).toBe(0);
  });
});

// ── start / stop lifecycle ────────────────────────────────────────────────
describe('ActiveModelSubscriber — start / destroy lifecycle', () => {
  it('start() skips when MODEL_SUBSCRIBER_DISABLED=true', () => {
    process.env.MODEL_SUBSCRIBER_DISABLED = 'true';
    const sub = new ActiveModelSubscriber(makeServing());
    sub.start();
    expect((sub as any).timer).toBeNull();
  });

  it('start() is idempotent — second call is a no-op', () => {
    jest.useFakeTimers();
    (global.fetch as any).mockResolvedValue(failResp(500));
    const sub = new ActiveModelSubscriber(makeServing());
    sub.start();
    const first = (sub as any).timer;
    sub.start();
    const second = (sub as any).timer;
    expect(second).toBe(first);
    sub.onModuleDestroy();
    jest.useRealTimers();
  });

  it('onModuleDestroy() clears the interval timer', () => {
    jest.useFakeTimers();
    (global.fetch as any).mockResolvedValue(failResp(500));
    const sub = new ActiveModelSubscriber(makeServing());
    sub.start();
    sub.onModuleDestroy();
    expect((sub as any).timer).toBeNull();
    jest.useRealTimers();
  });

  it('start() uses MODEL_POLL_INTERVAL_MS when set', () => {
    jest.useFakeTimers();
    process.env.MODEL_POLL_INTERVAL_MS = '500';
    (global.fetch as any).mockResolvedValue(failResp(500));
    const sub = new ActiveModelSubscriber(makeServing());
    sub.start();
    // Timer set — validated by the fact that onModuleDestroy clears it without error.
    expect((sub as any).timer).not.toBeNull();
    sub.onModuleDestroy();
    jest.useRealTimers();
  });
});

// ── Hardening — kill remaining behavioural mutants ────────────────────────
describe('ActiveModelSubscriber — hardening', () => {
  it('start() falls back to DEFAULT_INTERVAL_MS when env var is NaN ("||" branch)', () => {
    jest.useFakeTimers();
    process.env.MODEL_POLL_INTERVAL_MS = 'not-a-number';
    (global.fetch as any).mockResolvedValue(failResp(500));
    const sub = new ActiveModelSubscriber(makeServing());
    sub.start();
    // Trigger the interval once to ensure the callback is live (not a no-op
    // mutation of the setInterval body).
    (global.fetch as any).mockClear();
    jest.advanceTimersByTime(60_000);
    expect((global.fetch as any).mock.calls.length).toBeGreaterThanOrEqual(1);
    sub.onModuleDestroy();
    jest.useRealTimers();
  });

  it('tick() callback inside the scheduled loop actually runs (kills empty-body mutant)', async () => {
    // S1.8: the loop now self-schedules via setTimeout, which is async,
    // so we need advanceTimersByTimeAsync to flush both timers AND
    // pending microtasks between each tick.
    jest.useFakeTimers();
    process.env.MODEL_POLL_INTERVAL_MS = '100';
    (global.fetch as any).mockResolvedValue(failResp(500));
    const sub = new ActiveModelSubscriber(makeServing());
    const tickSpy = jest.spyOn(sub, 'tick');
    sub.start();
    tickSpy.mockClear();
    await jest.advanceTimersByTimeAsync(350); // ~3 interval ticks
    expect(tickSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    sub.onModuleDestroy();
    jest.useRealTimers();
  });

  it('onModuleDestroy() is safe when timer was never started', () => {
    const sub = new ActiveModelSubscriber(makeServing());
    expect((sub as any).timer).toBeNull();
    // The `if (this.timer)` guard must protect against a stray
    // clearInterval(null). Asserts the method doesn't throw.
    expect(() => sub.onModuleDestroy()).not.toThrow();
    expect((sub as any).timer).toBeNull();
  });

  it('tick() respects COORDINATOR_URL env override — fetch uses that host, not default', async () => {
    process.env.COORDINATOR_URL = 'http://override.internal:4444';
    (global.fetch as any).mockResolvedValueOnce(failResp(500));
    await new ActiveModelSubscriber(makeServing()).tick();
    const called = (global.fetch as any).mock.calls[0][0];
    expect(String(called)).toBe('http://override.internal:4444/models/active');
  });

  it('tick() uses default host http://localhost:3701 when env is unset', async () => {
    delete process.env.COORDINATOR_URL;
    (global.fetch as any).mockResolvedValueOnce(failResp(500));
    await new ActiveModelSubscriber(makeServing()).tick();
    const called = (global.fetch as any).mock.calls[0][0];
    expect(String(called)).toBe('http://localhost:3701/models/active');
  });

  it('tick() sends an AbortSignal to fetch (kills the "drop options" object mutant)', async () => {
    (global.fetch as any).mockResolvedValueOnce(failResp(500));
    await new ActiveModelSubscriber(makeServing()).tick();
    const opts = (global.fetch as any).mock.calls[0][1];
    expect(opts).toBeDefined();
    expect(opts.signal).toBeDefined();
    expect(typeof opts.signal.aborted).toBe('boolean');
  });

  it('tick() ignores a body with modelId when response.ok=false (guards against mutant dropping the ok check)', async () => {
    // Mutant `if (res.ok)` → `if (true)` would still parse the error body.
    // We return a failing response with a bogus active modelId — current
    // code must NOT consume it and must NOT advance to the download step.
    (global.fetch as any).mockResolvedValueOnce({
      ok: false, status: 500,
      json: async () => ({
        modelId: 'ATTACKER-ID', version: 99, generation: 9,
        sha256: 'deadbeef', bucketUrl: 'http://attacker/adapter.safetensors',
        manifestSignature: 'evil',
      }),
    });
    const serving = makeServing();
    const sub = new ActiveModelSubscriber(serving);
    const hook = jest.fn(async () => undefined);
    sub.setSwapHook(hook as any);
    const r = await sub.tick();
    expect(r).toBe('no-active');
    expect(hook).not.toHaveBeenCalled();
    expect(serving.setActiveVersion).not.toHaveBeenCalled();
  });

  it('tick() returns "unchanged" for the exact current modelId (kills !== mutant)', async () => {
    // Mutant: active.modelId !== this.currentModelId would trigger the
    // download path even for unchanged ids. We assert the opposite: no
    // second fetch happens when ids match.
    const sub = new ActiveModelSubscriber(makeServing());
    (sub as any).currentModelId = 'stable';
    (global.fetch as any).mockResolvedValueOnce(okResp({
      modelId: 'stable', version: 1, generation: 0,
      sha256: 'x', bucketUrl: 'http://b', manifestSignature: 'sig',
    }));
    expect(await sub.tick()).toBe('unchanged');
    // Only the /models/active fetch was made — no adapter download.
    expect((global.fetch as any).mock.calls.length).toBe(1);
  });

  it('first downloadAdapter run writes to cache when file does not exist', async () => {
    // Kills mutants around `fs.existsSync(target) && verifyAdapter(...)`.
    const bytes = Buffer.from('fresh-bytes');
    (global.fetch as any)
      .mockResolvedValueOnce(okResp({
        modelId: 'm-fresh', version: 1, generation: 0,
        sha256: sha256(bytes), bucketUrl: 'http://h/adapter.safetensors',
        manifestSignature: 'sig',
      }))
      .mockResolvedValueOnce(okResp(bytes, 'buffer'));
    const sub = new ActiveModelSubscriber(makeServing());
    sub.setSwapHook(async () => undefined);
    // Dev mode: no pubkey, no strict flag → manifest verification skipped.
    await sub.tick();
    // Cache file should now exist on disk.
    const files = fs.readdirSync(scratch);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const cached = fs.readFileSync(path.join(scratch, files[0]!));
    expect(cached.equals(bytes)).toBe(true);
  });

  it('verifyAdapter rejects when file does not exist (no throw)', () => {
    const sub: any = new ActiveModelSubscriber(makeServing());
    expect(sub.verifyAdapter('/nonexistent/path', 'abc')).toBe(false);
  });
});
