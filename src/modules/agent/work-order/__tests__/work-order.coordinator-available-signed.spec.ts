/**
 * F-coord-sec-010 — fetchAvailableWorkOrders signs the GET request.
 *
 * Regression: `GET /work-orders/available` is now behind the coord's
 * NodeSignatureGuard. The node used to hit it with a plain unsigned
 * `fetch(url)` carrying `?peerId=&capabilities=`, so every poll 401'd
 * ("Missing required auth headers") and the node was starved of the
 * HTTP pull path.
 *
 * This spec asserts the GET-safe signed shape that the guard verifies:
 *   - all four signed headers are present and non-empty
 *     (X-Peer-Id, X-Public-Key, X-Timestamp, X-Signature),
 *   - NO request body is sent on the GET, and NO Content-Type header
 *     (a body or Content-Type would flip the guard's canonical body to
 *     `'{}'` / trigger a 400 — the guard hashes `req.body`, which is
 *     `undefined` for a bodyless GET with no Content-Type → sha256('')),
 *   - the legacy `?peerId=` / `?capabilities=` query params are dropped
 *     (server ignores them),
 *   - the X-Signature verifies against the message
 *     `${peerId}:${ts}:${path}:${sha256('')}` — i.e. the EMPTY body hash,
 *     matching NodeSignatureGuard._hashBody(undefined),
 *   - the signed `path` matches the actual request URL path.
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

/**
 * The guard canonicalises an absent/empty body via
 * `String(body ?? '')` → `''`, then sha256 + base64. This is what both
 * the node-auth signer (body: undefined) and the guard (req.body
 * undefined) produce for a bodyless GET.
 */
function emptyBodyHash(): string {
  return Buffer.from(sha256(new TextEncoder().encode(''))).toString('base64');
}

describe('WorkOrderCoordinatorHelper.fetchAvailableWorkOrders — F-coord-sec-010 signed GET', () => {
  let helper: WorkOrderCoordinatorHelper;
  let fetchSpy: jest.SpiedFunction<typeof globalThis.fetch>;
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;
  const peerId = 'peer-avail-1';
  const coordinatorUrl = 'http://coord';

  beforeEach(() => {
    helper = new WorkOrderCoordinatorHelper();
    fetchSpy = jest.spyOn(globalThis, 'fetch') as never;
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('sends all four signed headers, no body, no Content-Type, and no ignored query params', async () => {
    const { privateKey, publicKey } = freshKeypair();
    helper.setIdentity(privateKey, publicKey, peerId);

    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => [] } as never);

    const result = await helper.fetchAvailableWorkOrders(coordinatorUrl, peerId, ['cpu_inference']);
    expect(result).toEqual([]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];

    // (1) Legacy query params are dropped — the path the node signs must
    //     equal the path it requests. Server ignores peerId/capabilities.
    expect(calledUrl).toBe(`${coordinatorUrl}/work-orders/available`);
    expect(calledUrl).not.toContain('peerId=');
    expect(calledUrl).not.toContain('capabilities=');

    // (2) GET — no request body.
    expect(calledInit.method).toBe('GET');
    expect(calledInit.body).toBeUndefined();

    const headers = calledInit.headers as Record<string, string>;

    // (3) No Content-Type on the GET (so the coord's express.json() leaves
    //     req.body === undefined → canonical body is the empty string).
    expect(headers['Content-Type']).toBeUndefined();

    // (4) All four signed headers present and non-empty.
    expect(headers['X-Peer-Id']).toBe(peerId);
    expect(headers['X-Public-Key']).toBeTruthy();
    expect(headers['X-Timestamp']).toBeTruthy();
    expect(headers['X-Signature']).toBeTruthy();
    expect(Buffer.from(headers['X-Signature'], 'base64').length).toBe(64);
    expect(Buffer.from(headers['X-Public-Key'], 'base64').length).toBe(32);

    // (5) Signature verifies against ${peerId}:${ts}:GET:${path}:${sha256('')}.
    const ts = headers['X-Timestamp'];
    const path = '/work-orders/available';
    const expectedMessage = `${peerId}:${ts}:GET:${path}:${emptyBodyHash()}`;
    const sigOk = verifyEd25519(
      new Uint8Array(Buffer.from(headers['X-Signature'], 'base64')),
      new TextEncoder().encode(expectedMessage),
      publicKey,
    );
    expect(sigOk).toBe(true);

    // (6) A signature computed over a non-empty body (`'{}'`) must NOT
    //     verify — regression guard against re-attaching a JSON body.
    const wrongBodyHash = Buffer.from(sha256(new TextEncoder().encode('{}'))).toString('base64');
    const wrongMessage = `${peerId}:${ts}:${path}:${wrongBodyHash}`;
    const wrongOk = verifyEd25519(
      new Uint8Array(Buffer.from(headers['X-Signature'], 'base64')),
      new TextEncoder().encode(wrongMessage),
      publicKey,
    );
    expect(wrongOk).toBe(false);
  });

  it('returns [] and warns on a non-2xx coordinator response', async () => {
    const { privateKey, publicKey } = freshKeypair();
    helper.setIdentity(privateKey, publicKey, peerId);

    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'UNAUTHORIZED', message: 'Missing required auth headers' }),
    } as never);

    const result = await helper.fetchAvailableWorkOrders(coordinatorUrl, peerId, []);
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[FetchWO]'));
  });
});
