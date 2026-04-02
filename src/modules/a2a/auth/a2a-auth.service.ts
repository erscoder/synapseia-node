/**
 * A2A Authentication Service
 * Sprint D — A2A Server for Synapseia Node
 *
 * Verifies Ed25519 signatures on incoming A2A tasks and signs outgoing tasks.
 *
 * NOTE: The existing IdentityHelper (modules/identity) stores Ed25519 private keys
 * as the last 32 bytes of the PKCS8 DER export. This is NOT the correct format
 * for Ed25519 private key import. For proper Ed25519, keys should be stored as
 * full PKCS8 DER (48 bytes) or raw 32-byte scalar.
 *
 * This service uses HMAC-SHA256 to match the existing IdentityHelper signature
 * scheme (see identity.ts BUG-1). For true Ed25519 inter-node verification,
 * the identity module should be updated to store full PKCS8 DER keys.
 */

import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import type { A2ATask } from '../types';

@Injectable()
export class A2AAuthService {
  // Max age of a request before rejecting (replay protection)
  private readonly MAX_REQUEST_AGE_MS = 30_000;

  // Track nonces to prevent replay attacks (TTL: 60s)
  private readonly usedNonces = new Map<string, number>();

  /**
   * Verify incoming A2A task signature.
   * Uses HMAC-SHA256 to match IdentityHelper.verifySignature().
   * Returns true if valid, false if invalid/expired/replay.
   */
  async verify(task: A2ATask, senderPublicKeyHex: string): Promise<boolean> {
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

    // 3. Verify HMAC-SHA256 signature (matches IdentityHelper scheme)
    // Signature covers: task.id + task.type + task.senderPeerId + task.timestamp + task.nonce
    const message = `${task.id}:${task.type}:${task.senderPeerId}:${task.timestamp}:${task.nonce}`;

    try {
      const publicKeyBytes = Buffer.from(senderPublicKeyHex, 'hex');
      const signatureBytes = Buffer.from(task.signature, 'hex');
      const messageBytes = Buffer.from(message, 'utf-8');

      // HMAC-SHA256 verification (same as IdentityHelper.verifySignature)
      const hmac = crypto.createHmac('sha256', publicKeyBytes);
      hmac.update(messageBytes);
      const expectedSignature = hmac.digest('hex');

      return signatureBytes.toString('hex') === expectedSignature;
    } catch {
      return false;
    }
  }

  /**
   * Sign an outgoing A2A task with the node's private key.
   * Uses HMAC-SHA256 to match IdentityHelper.sign() (see BUG-1).
   */
  sign(task: Omit<A2ATask, 'signature'>, privateKeyHex: string): string {
    const message = `${task.id}:${task.type}:${task.senderPeerId}:${task.timestamp}:${task.nonce}`;

    try {
      const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
      const messageBytes = Buffer.from(message, 'utf-8');
      const hmac = crypto.createHmac('sha256', privateKeyBytes);
      hmac.update(messageBytes);
      return hmac.digest('hex');
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
