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
import { sha512 } from '@noble/hashes/sha512';
import { sha256 } from '@noble/hashes/sha256';

// @noble/ed25519 v2.x requires sha512Sync to be configured before use.
// Without this, sign() throws "hashes.sha512Sync not set".
ed.etc.sha512Sync = (...msgs) => sha512(...msgs);

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
