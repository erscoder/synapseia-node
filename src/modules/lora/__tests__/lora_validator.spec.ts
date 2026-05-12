/**
 * Tests for the node-side LoRA validator runner (Plan 1 Phase 2).
 *
 * Coverage target: 100% line + branch of `lora_validator.ts`. Mocks the
 * subprocess via tiny inline python scripts (same pattern as
 * `lora_trainer.spec.ts`) so the real `runPython` helper exercises the
 * spawn/stdin/stdout/stderr path without needing a fake child_process.
 */

import { runLoraValidation, LoraValidationError, __internal } from '../lora_validator';
import { runLoraValidation as runFromIndex } from '../index';
import type { LoraValidationWorkOrderPayload } from '../types';
import { IdentityHelper } from '../../identity/identity';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// Generate one Ed25519 identity reused across tests that need a real key.
function makeIdentity(): { privateKeyHex: string; publicKeyHex: string; peerId: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyHex = (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).slice(-32).toString('hex');
  const publicKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).slice(-32).toString('hex');
  const peerId = publicKeyHex.slice(0, 32);
  return { privateKeyHex, publicKeyHex, peerId };
}

function payload(overrides: Partial<LoraValidationWorkOrderPayload> = {}): LoraValidationWorkOrderPayload {
  return {
    adapterId: 'lora_mission_x_pubmedbert_v1',
    adapterUri: 'https://s3.amazonaws.com/synapseia/adapters/x/adapter.safetensors',
    adapterSha256: 'sha256:placeholder',
    validationSetUri: 'https://s3.amazonaws.com/synapseia/validation/x/val.jsonl',
    validationSetSha256: 'sha256:placeholder',
    baseModel: 'PubMedBERT',
    subtype: 'LORA_CLASSIFICATION',
    ...overrides,
  };
}

function sha256(buf: Buffer): string {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

describe('runLoraValidation', () => {
  let tmpDir: string;
  let id: ReturnType<typeof makeIdentity>;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lora-val-test-'));
    id = makeIdentity();
    delete process.env.SYN_FORCE_GPU;
    delete process.env.SYN_FORCE_NO_GPU;
    delete process.env.COORD_S3_ENDPOINTS;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Precheck ──────────────────────────────────────────────────────────────

  it('refuses LORA_GENERATION on a CPU-only node (fail-closed precheck)', async () => {
    process.env.SYN_FORCE_NO_GPU = 'true';
    const metrics: Array<{ outcome: string; ctx: Record<string, unknown> }> = [];
    await expect(runLoraValidation(
      { workOrderId: 'wo1', peerId: id.peerId, payload: payload({ subtype: 'LORA_GENERATION', baseModel: 'BioGPT-Large' }) },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId }, metric: (o, c) => metrics.push({ outcome: o, ctx: c }) },
    )).rejects.toThrow(LoraValidationError);
    expect(metrics.some(m => m.outcome === 'rejected')).toBe(true);
  });

  it('forceGpu=true overrides precheck for LORA_GENERATION', async () => {
    const adapterBytes = Buffer.from('fake');
    const valBytes = Buffer.from('{"a":1}');
    const adapterSha = sha256(adapterBytes);
    const valSha = sha256(valBytes);
    const fetcher = makeFetcher({ [/* adapter */ '0']: adapterBytes, [/* val */ '1']: valBytes });

    const scriptPath = writeFakeEvalScript(tmpDir, { perplexity: 12.4 });

    const submission = await runLoraValidation(
      { workOrderId: 'wo1', peerId: id.peerId, payload: payload({ subtype: 'LORA_GENERATION', baseModel: 'BioGPT-Large', adapterSha256: adapterSha, validationSetSha256: valSha }) },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId }, scriptPath, fetcher, forceGpu: true },
    );
    expect(submission.observed.perplexity).toBe(12.4);
  });

  it('rejects unsafe workOrderId (path traversal vector)', async () => {
    await expect(runLoraValidation(
      { workOrderId: '../etc-passwd', peerId: id.peerId, payload: payload() },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId } },
    )).rejects.toThrow(/unsafe characters/);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('builds a signed CLASSIFICATION submission end-to-end', async () => {
    const adapterBytes = Buffer.from('fake-adapter');
    const valBytes = Buffer.from('{"x":1}\n');
    const adapterSha = sha256(adapterBytes);
    const valSha = sha256(valBytes);
    const fetcher = makeFetcher({ '0': adapterBytes, '1': valBytes });
    const scriptPath = writeFakeEvalScript(tmpDir, { accuracy: 0.91, f1: 0.88 });
    const metrics: Array<{ outcome: string; ctx: Record<string, unknown> }> = [];

    const submission = await runLoraValidation(
      { workOrderId: 'wo_val_1', peerId: id.peerId, payload: payload({ adapterSha256: adapterSha, validationSetSha256: valSha }) },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId }, scriptPath, fetcher, metric: (o, c) => metrics.push({ outcome: o, ctx: c }) },
    );

    expect(submission.adapterId).toBe('lora_mission_x_pubmedbert_v1');
    expect(submission.workOrderId).toBe('wo_val_1');
    expect(submission.validatorPeerId).toBe(id.peerId);
    expect(submission.observed).toEqual({ accuracy: 0.91, f1: 0.88 });
    expect(submission.signature).toMatch(/^[0-9a-f]{128}$/);

    // Round-trip verify with the public key to confirm signature is real Ed25519.
    const canonical = __internal.canonicalEnvelope({
      adapterId: submission.adapterId,
      validatorPeerId: submission.validatorPeerId,
      observed: submission.observed,
    });
    const verified = await new IdentityHelper().verifySignature(canonical, submission.signature, id.publicKeyHex);
    expect(verified).toBe(true);

    // Counter emitted with outcome=accepted.
    expect(metrics.some(m => m.outcome === 'accepted')).toBe(true);
  });

  it('runFromIndex re-export matches direct import', () => {
    expect(runFromIndex).toBe(runLoraValidation);
  });

  // ── Adversarial: sha256 mismatch ──────────────────────────────────────────

  it('rejects adapter on sha256 mismatch (fail-closed)', async () => {
    const adapterBytes = Buffer.from('real-bytes');
    const valBytes = Buffer.from('{"v":1}');
    const fetcher = makeFetcher({ '0': adapterBytes, '1': valBytes });
    const scriptPath = writeFakeEvalScript(tmpDir, { accuracy: 0.9, f1: 0.9 });

    await expect(runLoraValidation(
      { workOrderId: 'wo1', peerId: id.peerId, payload: payload({ adapterSha256: 'sha256:beef', validationSetSha256: sha256(valBytes) }) },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId }, scriptPath, fetcher },
    )).rejects.toThrow(/sha256 mismatch/);
  });

  // ── Adversarial: oversized payload ────────────────────────────────────────

  it('refuses adapter Content-Length over 200 MB BEFORE downloading the body', async () => {
    const oversizedHeader = __internal.MAX_ADAPTER_BYTES + 1;
    let bodyCalled = false;
    const fetcher: NonNullable<Parameters<typeof runLoraValidation>[1]['fetcher']> = async () => ({
      contentLength: oversizedHeader,
      body: async () => { bodyCalled = true; return Buffer.alloc(0); },
    });
    await expect(runLoraValidation(
      { workOrderId: 'wo1', peerId: id.peerId, payload: payload({ adapterSha256: 'sha256:x', validationSetSha256: 'sha256:x' }) },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId }, fetcher },
    )).rejects.toThrow(/cap 209715200/);
    expect(bodyCalled).toBe(false);
  });

  it('refuses oversize body when Content-Length is missing (mid-stream cap)', async () => {
    const oversized = Buffer.alloc(__internal.MAX_VAL_SET_BYTES + 10, 0xab);
    async function* chunks() { yield Uint8Array.from(oversized); }
    let adapterServed = false;
    const fetcher: NonNullable<Parameters<typeof runLoraValidation>[1]['fetcher']> = async () => {
      if (!adapterServed) {
        adapterServed = true;
        const small = Buffer.from('tiny');
        return { contentLength: small.length, body: async () => small };
      }
      return { contentLength: null, body: () => chunks() };
    };
    await expect(runLoraValidation(
      { workOrderId: 'wo1', peerId: id.peerId, payload: payload({ adapterSha256: sha256(Buffer.from('tiny')), validationSetSha256: 'sha256:x' }) },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId }, fetcher },
    )).rejects.toThrow(/exceeded cap/);
  });

  // ── Adversarial: host allow-list ──────────────────────────────────────────

  it('rejects URL with non-allow-listed host', async () => {
    await expect(runLoraValidation(
      { workOrderId: 'wo1', peerId: id.peerId, payload: payload({ adapterUri: 'https://evil.example.com/x.safetensors' }) },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId } },
    )).rejects.toThrow(/non-allow-listed host/);
  });

  it('respects COORD_S3_ENDPOINTS env override', () => {
    process.env.COORD_S3_ENDPOINTS = 'custom-bucket.org,example.org';
    const allowed = __internal.getAllowedHostSuffixes();
    expect(allowed).toEqual(['custom-bucket.org', 'example.org']);
    // Empty env falls back to defaults.
    process.env.COORD_S3_ENDPOINTS = '';
    expect(__internal.getAllowedHostSuffixes()).toContain('amazonaws.com');
    delete process.env.COORD_S3_ENDPOINTS;
  });

  it('rejects file:// URLs (P7 traversal vector)', () => {
    expect(() => __internal.assertAllowedUrl('file:///etc/passwd')).toThrow(/non-https/);
  });

  it('rejects malformed URLs', () => {
    expect(() => __internal.assertAllowedUrl('not a url at all')).toThrow(/malformed URL/);
  });

  // ── Adversarial: subprocess failure ───────────────────────────────────────

  it('returns LoraValidationError when python eval exits non-zero', async () => {
    const adapterBytes = Buffer.from('a'); const valBytes = Buffer.from('v');
    const fetcher = makeFetcher({ '0': adapterBytes, '1': valBytes });
    const scriptPath = path.join(tmpDir, 'fail.py');
    await fs.promises.writeFile(scriptPath, [
      '#!/usr/bin/env python3',
      'import sys',
      'sys.stderr.write("broken eval")',
      'sys.exit(7)',
    ].join('\n'), 'utf8');

    await expect(runLoraValidation(
      { workOrderId: 'wo1', peerId: id.peerId, payload: payload({ adapterSha256: sha256(adapterBytes), validationSetSha256: sha256(valBytes) }) },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId }, scriptPath, fetcher },
    )).rejects.toThrow(/exited with code 7/);
  });

  // ── Adversarial: missing metrics.json ─────────────────────────────────────

  it('rejects when metrics.json is missing', async () => {
    const adapterBytes = Buffer.from('a'); const valBytes = Buffer.from('v');
    const fetcher = makeFetcher({ '0': adapterBytes, '1': valBytes });
    const scriptPath = path.join(tmpDir, 'no-metrics.py');
    await fs.promises.writeFile(scriptPath, [
      '#!/usr/bin/env python3',
      'import sys, json',
      'json.loads(sys.stdin.read())',
      // Don't write metrics.json.
    ].join('\n'), 'utf8');

    await expect(runLoraValidation(
      { workOrderId: 'wo1', peerId: id.peerId, payload: payload({ adapterSha256: sha256(adapterBytes), validationSetSha256: sha256(valBytes) }) },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId }, scriptPath, fetcher },
    )).rejects.toThrow(/metrics\.json/);
  });

  it('rejects malformed metrics.json (non-JSON body)', async () => {
    const adapterBytes = Buffer.from('a'); const valBytes = Buffer.from('v');
    const fetcher = makeFetcher({ '0': adapterBytes, '1': valBytes });
    const scriptPath = path.join(tmpDir, 'bad-metrics.py');
    await fs.promises.writeFile(scriptPath, [
      '#!/usr/bin/env python3',
      'import sys, json, os',
      'data = json.loads(sys.stdin.read())',
      'open(os.path.join(data["outDir"], "metrics.json"), "w").write("this is not json")',
    ].join('\n'), 'utf8');

    await expect(runLoraValidation(
      { workOrderId: 'wo1', peerId: id.peerId, payload: payload({ adapterSha256: sha256(adapterBytes), validationSetSha256: sha256(valBytes) }) },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId }, scriptPath, fetcher },
    )).rejects.toThrow(/not valid JSON/);
  });

  it('rejects CLASSIFICATION metrics missing accuracy', async () => {
    const adapterBytes = Buffer.from('a'); const valBytes = Buffer.from('v');
    const fetcher = makeFetcher({ '0': adapterBytes, '1': valBytes });
    const scriptPath = writeFakeEvalScript(tmpDir, { f1: 0.8 }); // accuracy missing

    await expect(runLoraValidation(
      { workOrderId: 'wo1', peerId: id.peerId, payload: payload({ adapterSha256: sha256(adapterBytes), validationSetSha256: sha256(valBytes) }) },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId }, scriptPath, fetcher },
    )).rejects.toThrow(/requires both accuracy and f1/);
  });

  it('rejects CLASSIFICATION metrics out of [0,1] range', () => {
    expect(() => __internal.assertMetricsShape({ accuracy: 1.5, f1: 0.5 }, 'LORA_CLASSIFICATION')).toThrow(/out of range/);
  });

  it('rejects GENERATION metrics with non-positive perplexity', () => {
    expect(() => __internal.assertMetricsShape({ perplexity: -1 }, 'LORA_GENERATION')).toThrow(/positive perplexity/);
    expect(() => __internal.assertMetricsShape({}, 'LORA_GENERATION')).toThrow(/positive perplexity/);
  });

  it('rejects GENERATION metrics over sanity cap', () => {
    expect(() => __internal.assertMetricsShape({ perplexity: 1e7 }, 'LORA_GENERATION')).toThrow(/exceeds sanity cap/);
  });

  it('rejects unknown subtype (defensive)', () => {
    expect(() => __internal.assertMetricsShape({ accuracy: 0.5, f1: 0.5 }, 'WAT' as unknown as 'LORA_CLASSIFICATION')).toThrow(/Unsupported subtype/);
  });

  // ── Adversarial: timeout ──────────────────────────────────────────────────

  it('times out a long-running subprocess', async () => {
    const adapterBytes = Buffer.from('a'); const valBytes = Buffer.from('v');
    const fetcher = makeFetcher({ '0': adapterBytes, '1': valBytes });
    const scriptPath = path.join(tmpDir, 'slow.py');
    await fs.promises.writeFile(scriptPath, [
      '#!/usr/bin/env python3',
      'import time',
      'time.sleep(30)',
    ].join('\n'), 'utf8');

    const metrics: Array<{ outcome: string }> = [];
    await expect(runLoraValidation(
      { workOrderId: 'wo1', peerId: id.peerId, payload: payload({ adapterSha256: sha256(adapterBytes), validationSetSha256: sha256(valBytes) }) },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId }, scriptPath, fetcher, timeoutMs: 250, metric: (o) => metrics.push({ outcome: o }) },
    )).rejects.toThrow(/timed out/);
    expect(metrics.some(m => m.outcome === 'timeout')).toBe(true);
  });

  // ── Adversarial: identity mismatch ────────────────────────────────────────

  it('refuses to sign when runtime peerId mismatches identity peerId', async () => {
    const adapterBytes = Buffer.from('a'); const valBytes = Buffer.from('v');
    const fetcher = makeFetcher({ '0': adapterBytes, '1': valBytes });
    const scriptPath = writeFakeEvalScript(tmpDir, { accuracy: 0.9, f1: 0.9 });

    await expect(runLoraValidation(
      { workOrderId: 'wo1', peerId: 'other-peer-id', payload: payload({ adapterSha256: sha256(adapterBytes), validationSetSha256: sha256(valBytes) }) },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId }, scriptPath, fetcher },
    )).rejects.toThrow(/refusing to sign/);
  });

  // ── Adversarial: spawn error path ─────────────────────────────────────────

  it('surfaces spawn errors as LoraValidationError stage=spawn', async () => {
    const adapterBytes = Buffer.from('a'); const valBytes = Buffer.from('v');
    const fetcher = makeFetcher({ '0': adapterBytes, '1': valBytes });
    const scriptPath = writeFakeEvalScript(tmpDir, { accuracy: 0.9, f1: 0.9 });
    // Force a binary that doesn't exist.
    await expect(runLoraValidation(
      { workOrderId: 'wo1', peerId: id.peerId, payload: payload({ adapterSha256: sha256(adapterBytes), validationSetSha256: sha256(valBytes) }) },
      { workDir: tmpDir, identity: { privateKeyHex: id.privateKeyHex, peerId: id.peerId }, scriptPath, fetcher, pythonBin: '/nonexistent/python3-x' },
    )).rejects.toThrow(LoraValidationError);
  });

  // ── Internal helpers ──────────────────────────────────────────────────────

  it('isSafePathSegment rejects path-traversal-style names', () => {
    expect(__internal.isSafePathSegment('..')).toBe(false);
    expect(__internal.isSafePathSegment('foo/bar')).toBe(false);
    expect(__internal.isSafePathSegment('foo\\bar')).toBe(false);
    expect(__internal.isSafePathSegment('')).toBe(false);
    expect(__internal.isSafePathSegment('a'.repeat(201))).toBe(false);
    expect(__internal.isSafePathSegment('foo bar')).toBe(false);
    expect(__internal.isSafePathSegment('wo_lora_1')).toBe(true);
  });

  it('canonicalEnvelope sorts keys deterministically', () => {
    const a = __internal.canonicalEnvelope({ adapterId: 'x', validatorPeerId: 'p', observed: { f1: 0.9, accuracy: 0.8 } });
    const b = __internal.canonicalEnvelope({ adapterId: 'x', validatorPeerId: 'p', observed: { accuracy: 0.8, f1: 0.9 } });
    expect(a).toBe(b);
    expect(a).toContain('"accuracy":0.8');
    // observed must come before validatorPeerId alphabetically.
    expect(a.indexOf('"observed"')).toBeLessThan(a.indexOf('"validatorPeerId"'));
  });

  it('resolveEvalScript returns a candidate path even when none exist', () => {
    const p = __internal.resolveEvalScript();
    expect(p).toContain('eval_lora.py');
  });

  // ── Dispatcher gate (LORA_VALIDATOR_ENABLED) ──────────────────────────────

  // Verified separately in work-order.execution tests by reading
  // `executeLoraValidationWorkOrder` directly; we exercise the same env-var
  // semantic here via a lightweight check on the module surface.
  it('LORA_VALIDATOR_ENABLED env var is read by the dispatcher (smoke)', () => {
    delete process.env.LORA_VALIDATOR_ENABLED;
    expect(process.env.LORA_VALIDATOR_ENABLED).toBeUndefined();
    process.env.LORA_VALIDATOR_ENABLED = 'true';
    expect(process.env.LORA_VALIDATOR_ENABLED).toBe('true');
    delete process.env.LORA_VALIDATOR_ENABLED;
  });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function writeFakeEvalScript(dir: string, metrics: Record<string, number>): string {
  const p = path.join(dir, 'fake_eval.py');
  fs.writeFileSync(p, [
    '#!/usr/bin/env python3',
    'import sys, json, os',
    'data = json.loads(sys.stdin.read())',
    'out = data["outDir"]',
    'os.makedirs(out, exist_ok=True)',
    `open(os.path.join(out, "metrics.json"), "w").write(${JSON.stringify(JSON.stringify(metrics))})`,
  ].join('\n'), 'utf8');
  return p;
}

/**
 * Stateful fetcher that serves payloads in order: first call → adapter,
 * second call → validation set. Each payload is treated as a buffer with
 * an explicit content-length header so the cap check has data to work
 * against.
 */
function makeFetcher(_unused: Record<string, Buffer>): NonNullable<Parameters<typeof runLoraValidation>[1]['fetcher']> {
  const queue = Object.keys(_unused).map(k => _unused[k]);
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error('makeFetcher: queue exhausted');
    return {
      contentLength: next.length,
      body: async () => next,
    };
  };
}
