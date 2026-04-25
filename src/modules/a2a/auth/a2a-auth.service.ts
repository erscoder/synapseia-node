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

@Injectable()
export class A2AAuthService {
  // Max age of a request before rejecting (replay protection)
  private readonly MAX_REQUEST_AGE_MS = 30_000;

  // Track nonces to prevent replay attacks (TTL: 60s)
  private readonly usedNonces = new Map<string, number>();

  /**
   * Verify incoming A2A task signature using Ed25519.
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

    // 3. Verify Ed25519 signature
    const message = `${task.id}:${task.type}:${task.senderPeerId}:${task.timestamp}:${task.nonce}`;

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
   * Sign an outgoing A2A task with the node's Ed25519 private key.
   */
  sign(task: Omit<A2ATask, 'signature'>, privateKeyHex: string): string {
    const message = `${task.id}:${task.type}:${task.senderPeerId}:${task.timestamp}:${task.nonce}`;

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
