/**
 * Shared Ed25519 signing utilities for node → coordinator requests.
 * Used by both WorkOrderCoordinatorHelper (NestJS HTTP) and HeartbeatHelper (axios).
 *
 * Signed message format: `${timestamp}:${path}:${bodyHash}`
 * - timestamp: Unix milliseconds
 * - path: URL path (e.g. /peer/heartbeat)
 * - bodyHash: SHA-256 of JSON-stringified body, base64-encoded
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
  const message = `${timestamp}:${path}:${bodyHash}`;
  const messageBytes = new TextEncoder().encode(message);
  const signature = sign(messageBytes, privateKey);

  return {
    'X-Peer-Id': peerId,
    'X-Public-Key': Buffer.from(publicKey).toString('base64'),
    'X-Timestamp': String(timestamp),
    'X-Signature': Buffer.from(signature).toString('base64'),
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
