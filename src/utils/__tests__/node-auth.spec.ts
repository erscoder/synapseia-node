/**
 * Phase 4 — spec for node-auth Ed25519 signing utilities.
 *
 * `@noble/ed25519` is mocked in jest.config.js (ESM incompatibility). For
 * signature-verification assertions we bypass the mock by using Node's
 * built-in `crypto` module — the byte contract is identical to @noble, so
 * signatures produced by the real library (via node-auth.ts) can be
 * verified with the same 32-byte public key.
 *
 * Coverage: header contract, body normalisation (object/null/undef/primitive/
 * array/nested), recursive key sorting, signature determinism, timestamp
 * freshness, privateKey untouched as input.
 */

import * as crypto from 'crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { buildAuthHeaders } from '../node-auth.js';

// ── helpers ────────────────────────────────────────────────────────────────
function freshKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const priv = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32);
  const pub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
  return { privateKey: new Uint8Array(priv), publicKey: new Uint8Array(pub) };
}

const SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');
function verifyEd25519(signature: Uint8Array, message: Uint8Array, pubKey: Uint8Array): boolean {
  const spki = Buffer.concat([SPKI_HEADER, Buffer.from(pubKey)]);
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
}

function hashBody(body: string): string {
  return Buffer.from(sha256(new TextEncoder().encode(body))).toString('base64');
}

// ── tests ──────────────────────────────────────────────────────────────────
describe('buildAuthHeaders', () => {
  let privateKey: Uint8Array;
  let publicKey: Uint8Array;

  beforeAll(() => {
    const kp = freshKeypair();
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
  });

  it('returns the four required headers', async () => {
    const h = await buildAuthHeaders({
      method: 'POST', path: '/peer/heartbeat', body: { alive: true },
      privateKey, publicKey, peerId: 'p1',
    });
    expect(h['X-Peer-Id']).toBe('p1');
    expect(typeof h['X-Public-Key']).toBe('string');
    expect(typeof h['X-Timestamp']).toBe('string');
    expect(typeof h['X-Signature']).toBe('string');
  });

  it('X-Public-Key is base64 of the raw 32-byte key', async () => {
    const h = await buildAuthHeaders({
      method: 'POST', path: '/x', body: {}, privateKey, publicKey, peerId: 'p',
    });
    expect(h['X-Public-Key']).toBe(Buffer.from(publicKey).toString('base64'));
  });

  it('X-Timestamp is a string of a recent Unix ms value', async () => {
    const before = Date.now();
    const h = await buildAuthHeaders({
      method: 'POST', path: '/x', body: {}, privateKey, publicKey, peerId: 'p',
    });
    const after = Date.now();
    const ts = parseInt(h['X-Timestamp'], 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('signs `${ts}:${path}:${bodyHash}` verifiable with real Ed25519', async () => {
    const body = { x: 1, y: 2 };
    const h = await buildAuthHeaders({
      method: 'POST', path: '/p', body, privateKey, publicKey, peerId: 'p',
    });
    const expected = `${h['X-Timestamp']}:/p:${hashBody(JSON.stringify(body))}`;
    expect(verifyEd25519(
      new Uint8Array(Buffer.from(h['X-Signature'], 'base64')),
      new TextEncoder().encode(expected),
      publicKey,
    )).toBe(true);
  });

  it('tampered path flips verify to false (sig is bound to path)', async () => {
    const h = await buildAuthHeaders({
      method: 'POST', path: '/real', body: {}, privateKey, publicKey, peerId: 'p',
    });
    const wrong = `${h['X-Timestamp']}:/different:${hashBody('{}')}`;
    expect(verifyEd25519(
      new Uint8Array(Buffer.from(h['X-Signature'], 'base64')),
      new TextEncoder().encode(wrong),
      publicKey,
    )).toBe(false);
  });

  it('body key order does not affect the canonical message', async () => {
    const h = await buildAuthHeaders({
      method: 'POST', path: '/p', body: { b: 2, a: 1 }, privateKey, publicKey, peerId: 'p',
    });
    const expected = `${h['X-Timestamp']}:/p:${hashBody(JSON.stringify({ a: 1, b: 2 }))}`;
    expect(verifyEd25519(
      new Uint8Array(Buffer.from(h['X-Signature'], 'base64')),
      new TextEncoder().encode(expected),
      publicKey,
    )).toBe(true);
  });

  it('null body normalises to empty string', async () => {
    const h = await buildAuthHeaders({
      method: 'GET', path: '/n', body: null, privateKey, publicKey, peerId: 'p',
    });
    const expected = `${h['X-Timestamp']}:/n:${hashBody('')}`;
    expect(verifyEd25519(
      new Uint8Array(Buffer.from(h['X-Signature'], 'base64')),
      new TextEncoder().encode(expected),
      publicKey,
    )).toBe(true);
  });

  it('undefined body normalises to empty string', async () => {
    const h = await buildAuthHeaders({
      method: 'GET', path: '/u', body: undefined, privateKey, publicKey, peerId: 'p',
    });
    const expected = `${h['X-Timestamp']}:/u:${hashBody('')}`;
    expect(verifyEd25519(
      new Uint8Array(Buffer.from(h['X-Signature'], 'base64')),
      new TextEncoder().encode(expected),
      publicKey,
    )).toBe(true);
  });

  it('primitive string body stringifies via String() — not JSON.stringify', async () => {
    const h = await buildAuthHeaders({
      method: 'POST', path: '/s', body: 'plain', privateKey, publicKey, peerId: 'p',
    });
    const expected = `${h['X-Timestamp']}:/s:${hashBody('plain')}`;
    expect(verifyEd25519(
      new Uint8Array(Buffer.from(h['X-Signature'], 'base64')),
      new TextEncoder().encode(expected),
      publicKey,
    )).toBe(true);
  });

  it('primitive number body → String(n)', async () => {
    const h = await buildAuthHeaders({
      method: 'POST', path: '/n', body: 42, privateKey, publicKey, peerId: 'p',
    });
    const expected = `${h['X-Timestamp']}:/n:${hashBody('42')}`;
    expect(verifyEd25519(
      new Uint8Array(Buffer.from(h['X-Signature'], 'base64')),
      new TextEncoder().encode(expected),
      publicKey,
    )).toBe(true);
  });

  it('nested object keys are sorted recursively', async () => {
    const h = await buildAuthHeaders({
      method: 'POST', path: '/nst', body: { outer: { z: 1, a: 2 }, other: 3 },
      privateKey, publicKey, peerId: 'p',
    });
    const expectedBody = JSON.stringify({ other: 3, outer: { a: 2, z: 1 } });
    const expected = `${h['X-Timestamp']}:/nst:${hashBody(expectedBody)}`;
    expect(verifyEd25519(
      new Uint8Array(Buffer.from(h['X-Signature'], 'base64')),
      new TextEncoder().encode(expected),
      publicKey,
    )).toBe(true);
  });

  it('array elements stay in order; nested objects inside arrays are sorted', async () => {
    const h = await buildAuthHeaders({
      method: 'POST', path: '/ao', body: [{ z: 1, a: 2 }, { b: 3 }],
      privateKey, publicKey, peerId: 'p',
    });
    const expectedBody = JSON.stringify([{ a: 2, z: 1 }, { b: 3 }]);
    const expected = `${h['X-Timestamp']}:/ao:${hashBody(expectedBody)}`;
    expect(verifyEd25519(
      new Uint8Array(Buffer.from(h['X-Signature'], 'base64')),
      new TextEncoder().encode(expected),
      publicKey,
    )).toBe(true);
  });

  it('pure number array preserves order after sortObjectKeys', async () => {
    const h = await buildAuthHeaders({
      method: 'POST', path: '/arr', body: [3, 1, 2],
      privateKey, publicKey, peerId: 'p',
    });
    const expected = `${h['X-Timestamp']}:/arr:${hashBody(JSON.stringify([3, 1, 2]))}`;
    expect(verifyEd25519(
      new Uint8Array(Buffer.from(h['X-Signature'], 'base64')),
      new TextEncoder().encode(expected),
      publicKey,
    )).toBe(true);
  });

  it('signatures differ across calls (timestamp advances)', async () => {
    const h1 = await buildAuthHeaders({
      method: 'POST', path: '/d', body: { a: 1 }, privateKey, publicKey, peerId: 'p',
    });
    await new Promise((r) => setTimeout(r, 5));
    const h2 = await buildAuthHeaders({
      method: 'POST', path: '/d', body: { a: 1 }, privateKey, publicKey, peerId: 'p',
    });
    expect(h1['X-Timestamp']).not.toBe(h2['X-Timestamp']);
    expect(h1['X-Signature']).not.toBe(h2['X-Signature']);
  });

  it('peerId of empty string is preserved (no defaulting)', async () => {
    const h = await buildAuthHeaders({
      method: 'POST', path: '/e', body: {}, privateKey, publicKey, peerId: '',
    });
    expect(h['X-Peer-Id']).toBe('');
  });

  it('private key is not mutated by sign', async () => {
    const before = Array.from(privateKey);
    await buildAuthHeaders({
      method: 'POST', path: '/p', body: {}, privateKey, publicKey, peerId: 'p',
    });
    expect(Array.from(privateKey)).toEqual(before);
  });

  it('nested null values are preserved — null-guard inside sortObjectKeys', async () => {
    // Kills the `obj !== null` → `true` mutant: without the guard the
    // recursive call tries `Object.keys(null).sort()` and throws.
    const h = await buildAuthHeaders({
      method: 'POST', path: '/nn', body: { a: null, b: { c: null } },
      privateKey, publicKey, peerId: 'p',
    });
    const expected = `${h['X-Timestamp']}:/nn:${hashBody(JSON.stringify({ a: null, b: { c: null } }))}`;
    expect(verifyEd25519(
      new Uint8Array(Buffer.from(h['X-Signature'], 'base64')),
      new TextEncoder().encode(expected),
      publicKey,
    )).toBe(true);
  });
});
