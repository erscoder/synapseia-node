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

  // Defensive normalization, mirroring buildWsHandshakeAuth: callers pass
  // `Buffer.from(identity.privateKey/publicKey, 'hex')`, which is already the
  // raw 32-byte key (identity.json stores raw hex, not DER), so this is a
  // no-op for valid input. It only matters if a DER-wrapped key is ever
  // passed in, in which case the trailing 32 bytes are sliced — keeping the
  // HTTP signer symmetric with the WS handshake signer, which already did
  // this. NOTE: the signed-message format below is unchanged.
  const privateKeyRaw = rawEd25519Key(privateKey);
  const publicKeyRaw = rawEd25519Key(publicKey);

  const bodyStr =
    typeof body === 'object' && body !== null
      ? JSON.stringify(sortObjectKeys(body))
      : String(body ?? '');

  const bodyHash = Buffer.from(sha256(new TextEncoder().encode(bodyStr))).toString('base64');
  const message = `${peerId}:${timestamp}:${path}:${bodyHash}`;
  const messageBytes = new TextEncoder().encode(message);
  const signature = sign(messageBytes, privateKeyRaw);

  return {
    'X-Peer-Id': peerId,
    'X-Public-Key': Buffer.from(publicKeyRaw).toString('base64'),
    'X-Timestamp': String(timestamp),
    'X-Signature': Buffer.from(signature).toString('base64'),
  };
}

/**
 * Normalize an Ed25519 key buffer down to the raw 32-byte form expected by
 * the signer and the coordinator's auth guards.
 *
 * CORRECTION (audit): identity files on disk (`identity.json`) store keys as
 * raw 32-byte hex, NOT DER. `IdentityHelper.generateIdentity` already slices
 * the trailing 32 bytes off Node's PKCS8/SPKI DER export and persists only
 * the raw scalar/point hex (see `modules/identity/identity.ts`). Callers
 * therefore pass `Buffer.from(identity.privateKey/publicKey, 'hex')`, which
 * is already exactly 32 bytes, so for the in-tree call sites this function is
 * a pass-through (the `buf.length === 32` branch).
 *
 * It is kept as a defensive guard for the unlikely case a DER-wrapped key is
 * ever handed in: anything longer than 32 bytes is treated as DER and the
 * trailing 32 bytes are sliced (the Ed25519 PKCS8 prefix is 16 bytes, the
 * SPKI prefix 12 bytes, so the key bytes are always the final 32).
 *
 * HISTORICAL ASYMMETRY (now resolved): `buildWsHandshakeAuth` always called
 * this helper, but `buildAuthHeaders` previously signed/sent the input
 * buffers directly. Both paths now route through `rawEd25519Key` so the HTTP
 * and WS signers behave identically. This is purely defensive — it does NOT
 * change the signed-message format on either path.
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
 * The coord-side `WsAuthService.verifyNode` (presentation/websocket/
 * ws-auth.guard.ts) reads `client.handshake.auth` and expects:
 * `peerId`, `publicKey` (hex, 32 bytes), `timestamp` (ms), `signature`
 * (hex, 64 bytes) over the message `${timestamp}:${peerId}:websocket:handshake`.
 *
 * F-coord-sec-002: the peerId is bound INTO the signed message so a
 * captured handshake signature can't be rebound to a different identity
 * (mirrors NodeSignatureGuard's `${peerId}:${ts}:...` HTTP format). The
 * pre-fix signer omitted `:${peerId}:` and signed the legacy
 * `${timestamp}:websocket:handshake`, so every node connection failed
 * Ed25519 verification → coord `client.disconnect(true)` →
 * "io server disconnect". Pass the result straight into
 * `io(url, { auth: ... })`.
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
  const message = `${timestamp}:${peerId}:websocket:handshake`;
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
