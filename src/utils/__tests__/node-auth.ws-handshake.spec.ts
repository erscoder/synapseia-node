/**
 * F-coord-sec-002 — buildWsHandshakeAuth signs the peerId-bound message.
 *
 * Regression: the coord's WS auth (`WsAuthService.verifyNode`,
 * presentation/websocket/ws-auth.guard.ts) reconstructs and verifies the
 * Ed25519 signature over `${timestamp}:${peerId}:websocket:handshake`. The
 * pre-fix node signer omitted `:${peerId}:` and signed the legacy
 * `${timestamp}:websocket:handshake`, so every node WS connection failed
 * verification → coord `client.disconnect(true)` → the node logged
 * "Disconnected from coordinator WS: io server disconnect" on every attempt.
 *
 * This spec rebuilds the coord's exact verification checks against the
 * payload the node sends and asserts:
 *   - the four handshake fields are present with the coord-expected
 *     encodings (peerId string, publicKey hex/32 bytes, timestamp ms string,
 *     signature hex/64 bytes),
 *   - the signature verifies against `${timestamp}:${peerId}:websocket:handshake`,
 *   - a signature checked against the LEGACY `${timestamp}:websocket:handshake`
 *     message does NOT verify (guards against re-introducing the bug),
 *   - the timestamp is within the coord's 5-minute tolerance window.
 *
 * `@noble/ed25519` is mocked in jest.config.js (ESM incompatibility); we
 * verify with Node's built-in `crypto`, whose byte contract is identical.
 */

import * as crypto from 'crypto';
import { buildWsHandshakeAuth } from '../node-auth.js';

const SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // mirrors coord ws-auth.guard.ts

function freshKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const priv = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32);
  const pub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
  return { privateKey: new Uint8Array(priv), publicKey: new Uint8Array(pub) };
}

/** Reconstruct the coord's hex-decode + Ed25519 verify exactly. */
function coordVerify(
  publicKeyHex: string,
  signatureHex: string,
  message: string,
): boolean {
  const pubKey = Buffer.from(publicKeyHex, 'hex');
  const sig = Buffer.from(signatureHex, 'hex');
  const spki = Buffer.concat([SPKI_HEADER, pubKey]);
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
}

describe('buildWsHandshakeAuth — F-coord-sec-002 peerId-bound WS handshake', () => {
  const peerId = 'peer-ws-1';

  it('emits the coord-expected fields and encodings', () => {
    const { privateKey, publicKey } = freshKeypair();
    const payload = buildWsHandshakeAuth({ privateKey, publicKey, peerId });

    expect(payload.peerId).toBe(peerId);
    // publicKey/signature are hex (coord does Buffer.from(x, 'hex')).
    expect(payload.publicKey).toMatch(/^[0-9a-f]+$/i);
    expect(payload.signature).toMatch(/^[0-9a-f]+$/i);
    expect(Buffer.from(payload.publicKey, 'hex').length).toBe(32);
    expect(Buffer.from(payload.signature, 'hex').length).toBe(64);
    // timestamp is a ms epoch string (coord does Number(timestamp)).
    expect(payload.timestamp).toMatch(/^\d+$/);
  });

  it('signature verifies against ${timestamp}:${peerId}:websocket:handshake', () => {
    const { privateKey, publicKey } = freshKeypair();
    const payload = buildWsHandshakeAuth({ privateKey, publicKey, peerId });

    // Exact coord message: F-coord-sec-002 binds peerId into the message.
    const message = `${payload.timestamp}:${peerId}:websocket:handshake`;
    expect(coordVerify(payload.publicKey, payload.signature, message)).toBe(true);
  });

  it('does NOT verify against the legacy ${timestamp}:websocket:handshake message', () => {
    const { privateKey, publicKey } = freshKeypair();
    const payload = buildWsHandshakeAuth({ privateKey, publicKey, peerId });

    // The pre-fix bug. If the signer regresses to omitting peerId, this
    // assertion flips and the test fails.
    const legacyMessage = `${payload.timestamp}:websocket:handshake`;
    expect(coordVerify(payload.publicKey, payload.signature, legacyMessage)).toBe(false);
  });

  it('does NOT verify when the peerId in the message differs (rebind guard)', () => {
    const { privateKey, publicKey } = freshKeypair();
    const payload = buildWsHandshakeAuth({ privateKey, publicKey, peerId });

    const rebound = `${payload.timestamp}:other-peer:websocket:handshake`;
    expect(coordVerify(payload.publicKey, payload.signature, rebound)).toBe(false);
  });

  it('timestamp is within the coord 5-minute tolerance window', () => {
    const { privateKey, publicKey } = freshKeypair();
    const payload = buildWsHandshakeAuth({ privateKey, publicKey, peerId });

    const skew = Math.abs(Date.now() - Number(payload.timestamp));
    expect(skew).toBeLessThan(TIMESTAMP_TOLERANCE_MS);
  });
});
