/**
 * Shared Ed25519 signing utilities for node → coordinator requests.
 * Used by both WorkOrderCoordinatorHelper (NestJS HTTP) and HeartbeatHelper (axios).
 *
 * Signed message format (post-S0.6): `${peerId}:${timestamp}:${path}:${bodyHash}`
 * - peerId: libp2p peer id (binds the signature to the claimed identity)
 * - timestamp: Unix milliseconds
 * - path: URL path (e.g. /peer/heartbeat)
 * - bodyHash: SHA-256 of JSON-stringified body, base64-encoded
 *
 * peerId was added so that two peers sharing a null DB key (e.g.
 * mid-self-registration) cannot replay each other's signed payloads.
 * The coordinator's NodeSignatureGuard expects the same format.
 */
import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

// @noble/ed25519 v3.x requires hashes.sha512 to be set before signing.
// Without this, sign() throws "hashes.sha512 not set".
// @noble/hashes v2 returns Uint8Array<ArrayBufferLike>; ed25519 v3 expects ArrayBuffer — cast is safe
(ed.hashes as Record<string, unknown>).sha512 = sha512;

const { sign } = ed;

export interface AuthHeaders {
  'X-Peer-Id': string;
  'X-Public-Key': string;
  'X-Timestamp': string;
  'X-Signature': string;
  [key: string]: string;
}

/**
 * Generate auth headers for a signed request.
 * Uses the node's Ed25519 keypair to sign the message.
 */
export async function buildAuthHeaders(params: {
  method: string;
  path: string;
  body: unknown;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  peerId: string;
}): Promise<AuthHeaders> {
  const { method, path, body, privateKey, publicKey, peerId } = params;
  const timestamp = Date.now();

  const bodyStr =
    typeof body === 'object' && body !== null
      ? JSON.stringify(sortObjectKeys(body))
      : String(body ?? '');

  const bodyHash = Buffer.from(sha256(new TextEncoder().encode(bodyStr))).toString('base64');
  const message = `${peerId}:${timestamp}:${path}:${bodyHash}`;
  const messageBytes = new TextEncoder().encode(message);
  const signature = sign(messageBytes, privateKey);

  return {
    'X-Peer-Id': peerId,
    'X-Public-Key': Buffer.from(publicKey).toString('base64'),
    'X-Timestamp': String(timestamp),
    'X-Signature': Buffer.from(signature).toString('base64'),
  };
}

/**
 * Identity files on disk store keys as PKCS8/SPKI DER (Node's
 * `KeyObject.export({ type: 'pkcs8' / 'spki', format: 'der' })`),
 * NOT raw Ed25519 32-byte seeds. The coord WS auth guard accepts only
 * raw hex (32 bytes for the public key), so we slice the trailing
 * 32 bytes from the DER blob before signing / sending. The DER prefix
 * for an Ed25519 PKCS8 private key is fixed at 16 bytes
 * (`30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20`); SPKI public is
 * 12 bytes (`30 2a 30 05 06 03 2b 65 70 03 21 00`). Anything longer
 * than 32 bytes is treated as DER and sliced; raw 32-byte buffers are
 * passed through.
 */
function rawEd25519Key(buf: Uint8Array): Uint8Array {
  if (buf.length === 32) return buf;
  if (buf.length < 32) {
    throw new Error(`rawEd25519Key: input too short (${buf.length} bytes)`);
  }
  return buf.slice(buf.length - 32);
}

/**
 * Build the auth payload for the coordinator's Socket.IO handshake.
 * The coord-side `verifyWsHandshake` (presentation/websocket/ws-auth.guard.ts)
 * expects: `peerId`, `publicKey` (hex), `timestamp` (ms), `signature` (hex)
 * over the message `${timestamp}:websocket:handshake`. Pass the result
 * straight into `io(url, { auth: ... })`.
 */
export function buildWsHandshakeAuth(params: {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  peerId: string;
}): { peerId: string; publicKey: string; timestamp: string; signature: string } {
  const { peerId } = params;
  const privateKeyRaw = rawEd25519Key(params.privateKey);
  const publicKeyRaw = rawEd25519Key(params.publicKey);
  const timestamp = Date.now();
  const message = `${timestamp}:websocket:handshake`;
  const messageBytes = new TextEncoder().encode(message);
  const signature = sign(messageBytes, privateKeyRaw);
  return {
    peerId,
    publicKey: Buffer.from(publicKeyRaw).toString('hex'),
    timestamp: String(timestamp),
    signature: Buffer.from(signature).toString('hex'),
  };
}

/** Recursively sort object keys for deterministic JSON serialization */
function sortObjectKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  if (typeof obj === 'object' && obj !== null) {
    return Object.keys(obj as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return obj;
}
