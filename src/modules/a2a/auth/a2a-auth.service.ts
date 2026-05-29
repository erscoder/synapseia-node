/**
 * A2A Authentication Service
 * Sprint D — A2A Server for Synapseia Node
 *
 * Verifies Ed25519 signatures on incoming A2A tasks and signs outgoing tasks.
 * Uses Ed25519 via Node.js native crypto (matching IdentityHelper.sign()).
 */

import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import type { A2ATask } from '../types';

/**
 * Derive the project peerId from a raw Ed25519 public key hex.
 *
 * Synapseia does NOT use libp2p CID multihash peerIds at the A2A layer —
 * `IdentityHelper.generateIdentity()` defines `peerId = publicKeyHex.slice(0, 32)`
 * (the first 16 bytes of the 32-byte raw Ed25519 pubkey, hex-encoded). The
 * pubkey is therefore *embedded* in the peerId by construction, so we can
 * re-derive the expected peerId from any presented public key and reject a
 * mismatch — closing the "bring your own keypair" bypass without pulling in
 * `@libp2p/peer-id` (which would not parse these truncated-hex ids anyway).
 *
 * Returns null when the input is not a valid 32-byte (64 hex char) Ed25519
 * public key, so callers fail closed.
 */
export function derivePeerIdFromPublicKey(publicKeyHex: string): string | null {
  if (typeof publicKeyHex !== 'string') return null;
  // 32-byte raw Ed25519 pubkey = exactly 64 lowercase/uppercase hex chars.
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) return null;
  return publicKeyHex.slice(0, 32).toLowerCase();
}

@Injectable()
export class A2AAuthService {
  // Max age of a request before rejecting (replay protection)
  private readonly MAX_REQUEST_AGE_MS = 30_000;

  // Track nonces to prevent replay attacks (TTL: 60s)
  private readonly usedNonces = new Map<string, number>();

  /**
   * Verify incoming A2A task signature using Ed25519.
   * Returns true if valid, false if invalid/expired/replay.
   *
   * Security (FINDING 1 + FINDING 2):
   * - Binds the presented X-Public-Key to `task.senderPeerId`: the pubkey
   *   must re-derive to the claimed peerId (fail-closed). A caller can no
   *   longer sign with a self-generated keypair and pass its own pubkey.
   * - Signs the whole task INCLUDING a canonical hash of `task.payload`, so
   *   a relay/MITM cannot swap the payload of an otherwise-valid signed task.
   */
  async verify(task: A2ATask, senderPublicKeyHex: string): Promise<boolean> {
    // 0. Identity binding — the presented pubkey MUST re-derive to the
    //    claimed senderPeerId. Fail closed on any mismatch / malformed key
    //    (reviewer-lessons P-identity: `if (!a || !b || a !== b) reject`).
    const derivedPeerId = derivePeerIdFromPublicKey(senderPublicKeyHex);
    if (
      !derivedPeerId ||
      !task.senderPeerId ||
      derivedPeerId !== task.senderPeerId.toLowerCase()
    ) {
      return false;
    }

    // 1. Check timestamp freshness
    const age = Date.now() - task.timestamp;
    if (age > this.MAX_REQUEST_AGE_MS || age < -5000) {
      return false;
    }

    // 2. Check nonce uniqueness (replay protection)
    if (this.usedNonces.has(task.nonce)) {
      return false;
    }
    this.usedNonces.set(task.nonce, Date.now());
    this.cleanExpiredNonces();

    // 3. Verify Ed25519 signature (covers the payload hash, see buildMessage)
    const message = this.buildMessage(task);

    try {
      const publicKeyBytes = Buffer.from(senderPublicKeyHex, 'hex');
      const signatureBytes = Buffer.from(task.signature, 'hex');
      const messageBytes = Buffer.from(message, 'utf-8');

      const ED25519_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
      const publicKeyDer = Buffer.concat([ED25519_DER_PREFIX, publicKeyBytes]);
      const keyObject = crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
      return crypto.verify(null, messageBytes, keyObject, signatureBytes);
    } catch {
      return false;
    }
  }

  /**
   * Build the canonical signed message for an A2A task. Includes a SHA-256
   * of the canonically-serialized payload so the signature commits to the
   * full task body (FINDING 2). `sign()` and `verify()` MUST use this same
   * function so both sides compute identical bytes.
   */
  buildMessage(task: Pick<A2ATask, 'id' | 'type' | 'senderPeerId' | 'timestamp' | 'nonce' | 'payload'>): string {
    const payloadHash = hashPayload(task.payload);
    return `${task.id}:${task.type}:${task.senderPeerId}:${task.timestamp}:${task.nonce}:${payloadHash}`;
  }

  /**
   * Derive the raw Ed25519 public key hex from a raw 32-byte private key hex.
   * Used by the A2A client to send the matching `X-Public-Key` header that the
   * server binds against `senderPeerId`. Returns null on malformed input.
   */
  derivePublicKeyHex(privateKeyHex: string): string | null {
    try {
      const PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');
      const derKey = Buffer.concat([PKCS8_HEADER, Buffer.from(privateKeyHex, 'hex')]);
      const privKeyObject = crypto.createPrivateKey({ key: derKey, format: 'der', type: 'pkcs8' });
      const pubKeyObject = crypto.createPublicKey(privKeyObject);
      const spki = pubKeyObject.export({ type: 'spki', format: 'der' }) as Buffer;
      return spki.subarray(-32).toString('hex');
    } catch {
      return null;
    }
  }

  /**
   * Sign an outgoing A2A task with the node's Ed25519 private key.
   */
  sign(task: Omit<A2ATask, 'signature'>, privateKeyHex: string): string {
    const message = this.buildMessage(task);

    try {
      const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
      const messageBytes = Buffer.from(message, 'utf-8');
      const PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');
      const derKey = Buffer.concat([PKCS8_HEADER, privateKeyBytes]);
      const keyObject = crypto.createPrivateKey({ key: derKey, format: 'der', type: 'pkcs8' });
      return crypto.sign(null, messageBytes, keyObject).toString('hex');
    } catch {
      return '';
    }
  }

  /**
   * Verify an Ed25519 signature using a full PKCS8 DER key.
   * Use this for true Ed25519 verification when the key is available
   * in proper PKCS8 format (not the identity module's truncated hex).
   */
  async verifyEd25519(
    message: string,
    signatureHex: string,
    publicKeyDer: Buffer,
  ): Promise<boolean> {
    try {
      const keyObject = crypto.createPublicKey({
        key: publicKeyDer,
        format: 'der',
        type: 'spki',
      });
      return crypto.verify(
        null,
        Buffer.from(message, 'utf-8'),
        keyObject,
        Buffer.from(signatureHex, 'hex'),
      );
    } catch {
      return false;
    }
  }

  /**
   * Sign with Ed25519 using a full PKCS8 DER key.
   * Use this for true Ed25519 signing when the key is available
   * in proper PKCS8 format.
   */
  signEd25519(message: string, privateKeyDer: Buffer): string {
    try {
      const keyObject = crypto.createPrivateKey({
        key: privateKeyDer,
        format: 'der',
        type: 'pkcs8',
      });
      return crypto
        .sign(null, Buffer.from(message, 'utf-8'), keyObject)
        .toString('hex');
    } catch {
      return '';
    }
  }

  /**
   * Clean up expired nonces (older than 60 seconds).
   */
  private cleanExpiredNonces(): void {
    const cutoff = Date.now() - 60_000;
    for (const [nonce, ts] of this.usedNonces.entries()) {
      if (ts < cutoff) {
        this.usedNonces.delete(nonce);
      }
    }
  }

  /**
   * Clear all tracked nonces (useful for testing).
   */
  clearNonces(): void {
    this.usedNonces.clear();
  }

  /**
   * Get the count of currently tracked nonces.
   */
  getNonceCount(): number {
    return this.usedNonces.size;
  }
}

/**
 * Deterministic JSON serialization with recursively-sorted object keys.
 *
 * Client and server MUST produce byte-identical output for the same logical
 * payload, otherwise the payload-hash check (FINDING 2) would reject valid
 * tasks. Arrays preserve order; object keys are sorted lexicographically;
 * primitives serialize via JSON.stringify. Mirrors the canonicalization
 * already used by `node-auth.ts` (`sortObjectKeys`) and
 * `IdentityHelper.canonicalPayload`.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const entries = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`,
    );
    return `{${entries.join(',')}}`;
  }
  // string / number / boolean / null → JSON primitive
  return JSON.stringify(value) ?? 'null';
}

/**
 * SHA-256 (hex) of the canonical JSON of an A2A task payload. An undefined
 * payload hashes as the canonical empty object so missing/empty payloads are
 * stable across client and server.
 */
export function hashPayload(payload: unknown): string {
  const canonical = canonicalJson(payload ?? {});
  return crypto.createHash('sha256').update(canonical, 'utf-8').digest('hex');
}
