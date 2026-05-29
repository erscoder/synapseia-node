/**
 * Bug 30 — uploadGradients signs {peerId, gradientsHash}.
 *
 * Pre-fix: the node signed `{peerId}` only, so the coord-side
 * NodeSignatureGuard (which hashes req.body, empty at guard-time for
 * multipart routes) produced a different bodyHash and the upload
 * 403'd 100% of the time, silently. Reward got paid, gradients went
 * to /dev/null.
 *
 * This spec asserts:
 *   - the request has an `X-Gradients-Sha256` header equal to
 *     sha256(file_bytes) (lowercase hex),
 *   - the FormData includes a `gradientsHash` text field with the
 *     same value (defense-in-depth against parser-ordering),
 *   - the X-Signature header verifies against the message
 *     `${peerId}:${ts}:${path}:${sha256(canonical({peerId, gradientsHash}))}`
 *     using Node's crypto.verify against the public key,
 *   - on a 200 response the helper returns true.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as crypto from 'crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { WorkOrderCoordinatorHelper } from '../work-order.coordinator';
import logger from '../../../../utils/logger';

const SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');

function freshKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const priv = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32);
  const pub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
  return { privateKey: new Uint8Array(priv), publicKey: new Uint8Array(pub) };
}

function verifyEd25519(signature: Uint8Array, message: Uint8Array, pubKey: Uint8Array): boolean {
  const spki = Buffer.concat([SPKI_HEADER, Buffer.from(pubKey)]);
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
}

function sortKeys(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object') {
    return Object.keys(o as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = sortKeys((o as Record<string, unknown>)[k]);
      return acc;
    }, {});
  }
  return o;
}

function canonicalBodyHash(body: unknown): string {
  const bodyStr = JSON.stringify(sortKeys(body));
  return Buffer.from(sha256(new TextEncoder().encode(bodyStr))).toString('base64');
}

describe('WorkOrderCoordinatorHelper.uploadGradients — Bug 30 sign over gradientsHash', () => {
  let helper: WorkOrderCoordinatorHelper;
  let fetchSpy: jest.SpiedFunction<typeof globalThis.fetch>;
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;
  let logSpy: jest.SpiedFunction<typeof logger.log>;
  const peerId = 'peer-grad-1';
  const domain = 'medical';
  const coordinatorUrl = 'http://coord';

  beforeEach(() => {
    helper = new WorkOrderCoordinatorHelper();
    fetchSpy = jest.spyOn(globalThis, 'fetch') as never;
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('signs {peerId, gradientsHash} (not just {peerId}) and sets X-Gradients-Sha256 header', async () => {
    const { privateKey, publicKey } = freshKeypair();
    helper.setIdentity(privateKey, publicKey, peerId);

    const gradientBuffer = Buffer.from('fake-gradient-payload-bytes');
    const expectedSha = crypto.createHash('sha256').update(gradientBuffer).digest('hex');

    fetchSpy.mockResolvedValue({ ok: true, status: 200, text: async () => '' } as never);

    const outcome = await helper.uploadGradients(coordinatorUrl, domain, peerId, gradientBuffer);
    expect(outcome).toEqual({ ok: true, roundClosed: false, status: 200 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`${coordinatorUrl}/diloco/${domain}/gradients`);

    const headers = calledInit.headers as Record<string, string>;
    // (1) X-Gradients-Sha256 header is present and equals sha256(file).
    expect(headers['X-Gradients-Sha256']).toBe(expectedSha);
    // (2) Sig headers present.
    expect(headers['X-Peer-Id']).toBe(peerId);
    expect(typeof headers['X-Signature']).toBe('string');
    expect(typeof headers['X-Timestamp']).toBe('string');

    // (3) Signature verifies against ${peerId}:${ts}:POST:${path}:${sha256(canonical({peerId, gradientsHash}))}.
    const ts = headers['X-Timestamp'];
    const path = `/diloco/${domain}/gradients`;
    const bodyHash = canonicalBodyHash({ peerId, gradientsHash: expectedSha });
    const expectedMessage = `${peerId}:${ts}:POST:${path}:${bodyHash}`;
    const sigOk = verifyEd25519(
      new Uint8Array(Buffer.from(headers['X-Signature'], 'base64')),
      new TextEncoder().encode(expectedMessage),
      publicKey,
    );
    expect(sigOk).toBe(true);

    // (4) The old `{peerId}`-only sig must NOT verify (regression
    // guard against re-introducing Bug 30).
    const oldBodyHash = canonicalBodyHash({ peerId });
    const oldMessage = `${peerId}:${ts}:${path}:${oldBodyHash}`;
    const oldSigOk = verifyEd25519(
      new Uint8Array(Buffer.from(headers['X-Signature'], 'base64')),
      new TextEncoder().encode(oldMessage),
      publicKey,
    );
    expect(oldSigOk).toBe(false);
  });

  it('returns {ok:false, roundClosed:false} and warns on a transient non-2xx (403 sig race)', async () => {
    const { privateKey, publicKey } = freshKeypair();
    helper.setIdentity(privateKey, publicKey, peerId);

    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Invalid Ed25519 signature',
    } as never);

    const outcome = await helper.uploadGradients(coordinatorUrl, domain, peerId, Buffer.from('x'));
    // 403 is transient (sig race) — NOT a closed round, so the node keeps the WO.
    expect(outcome).toEqual({ ok: false, roundClosed: false, status: 403 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[DiLoCo] Failed to upload gradients'));
  });

  it('flags roundClosed=true on a 422 "No active DiLoCo round for domain" (terminal — abort)', async () => {
    const { privateKey, publicKey } = freshKeypair();
    helper.setIdentity(privateKey, publicKey, peerId);

    // Nest's default exception filter ships the thrown Error message in `message`.
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () =>
        JSON.stringify({ statusCode: 422, message: 'No active DiLoCo round for domain "medical"' }),
    } as never);

    const outcome = await helper.uploadGradients(coordinatorUrl, domain, peerId, Buffer.from('x'));
    expect(outcome).toEqual({ ok: false, roundClosed: true, status: 422 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[DiLoCo] Failed to upload gradients'));
  });

  it('does NOT flag roundClosed for an UNRELATED 422 (e.g. hash mismatch)', async () => {
    const { privateKey, publicKey } = freshKeypair();
    helper.setIdentity(privateKey, publicKey, peerId);

    fetchSpy.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () =>
        JSON.stringify({ statusCode: 422, message: 'gradients tensor failed norm-sanity check' }),
    } as never);

    const outcome = await helper.uploadGradients(coordinatorUrl, domain, peerId, Buffer.from('x'));
    // A different 422 is treated as a normal transient failure (node keeps the WO).
    expect(outcome).toEqual({ ok: false, roundClosed: false, status: 422 });
  });

  it('returns {ok:false, roundClosed:false} (no status) on a fetch network error', async () => {
    const { privateKey, publicKey } = freshKeypair();
    helper.setIdentity(privateKey, publicKey, peerId);
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const outcome = await helper.uploadGradients(coordinatorUrl, domain, peerId, Buffer.from('x'));
    expect(outcome).toEqual({ ok: false, roundClosed: false });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Upload error'));
  });
});
