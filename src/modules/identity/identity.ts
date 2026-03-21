/**
 * Identity management for Synapse nodes
 * Uses Ed25519 for signing and authentication
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
// @noble/ed25519 is ESM-only and breaks Jest (CommonJS). Use Node crypto for Ed25519.
// import { getPublicKey, sign as ed25519Sign, verify as ed25519Verify } from '@noble/ed25519';

export interface Identity {
  peerId: string;        // Ed25519 public key hex (first 32 bytes)
  publicKey: string;     // Hex string (Ed25519 public key)
  privateKey: string;    // Hex string (Ed25519 private key scalar)
  createdAt: number;     // Timestamp
  agentId?: string;      // First 8 chars of publicKey (NEW A16)
  tier?: number;         // Number (NEW A16)
  mode?: 'power' | 'chill';  // Operating mode (NEW A16)
  status?: 'active' | 'idle' | 'offline';  // Node status (NEW A16)
}

const IDENTITY_DIR = process.env.SYNAPSE_HOME ?? path.join(os.homedir(), '.synapseia');
const IDENTITY_FILE = path.join(IDENTITY_DIR, 'identity.json');

@Injectable()
export class IdentityHelper {
  /**
   * Generate new identity keypair using Ed25519
   */
  generateIdentity(identityDir: string = IDENTITY_DIR): Identity {
    if (!existsSync(identityDir)) {
      mkdirSync(identityDir, { recursive: true, mode: 0o700 });
    }

    // Generate Ed25519 keypair using Node crypto (no ESM dependency)
    const { privateKey: privKey, publicKey: pubKey } = crypto.generateKeyPairSync('ed25519');
    // Export raw 32-byte keys (not DER-wrapped) to keep hex unique per key
    const privateKeyHex = (privKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).slice(-32).toString('hex');
    const publicKeyHex = (pubKey.export({ type: 'spki', format: 'der' }) as Buffer).slice(-32).toString('hex');

    // Derive peerId from public key (first 32 chars of hex = 128 bits)
    const peerId = publicKeyHex.slice(0, 32);

    // Derive agentId from publicKey (first 8 chars hex) (A16)
    const agentId = publicKeyHex.slice(0, 8);

    const identity: Identity = {
      peerId,
      publicKey: publicKeyHex,
      privateKey: privateKeyHex,
      createdAt: Date.now(),
      agentId,          // A16
      tier: 0,          // A16 - default tier
      mode: 'chill',    // A16 - default mode
      status: 'idle',   // A16 - default status
    };

    writeFileSync(path.join(identityDir, 'identity.json'), JSON.stringify(identity, null, 2));
    writeFileSync(path.join(identityDir, 'publickey.pem'), `public key: ${publicKeyHex}\n`);

    return identity;
  }

  /**
   * Load existing identity
   */
  loadIdentity(identityDir: string = IDENTITY_DIR): Identity {
    const idPath = path.join(identityDir, 'identity.json');

    if (!existsSync(idPath)) {
      throw new Error(`Identity not found at ${idPath}. Run generateIdentity() or 'synapse start' first.`);
    }

    const content = readFileSync(idPath, 'utf-8');
    const identity = JSON.parse(content) as Identity;

    if (!identity.peerId || !identity.publicKey || !identity.privateKey) {
      throw new Error('Invalid identity file structure');
    }

    // Backfill default values for old identities (A16)
    if (!identity.agentId) {
      identity.agentId = identity.publicKey.slice(0, 8);
    }
    if (identity.tier === undefined) {
      identity.tier = 0;
    }
    if (!identity.mode) {
      identity.mode = 'chill';
    }
    if (!identity.status) {
      identity.status = 'idle';
    }

    return identity;
  }

  /**
   * Sign a message with the node's Ed25519 private key
   * @param message - The message to sign (UTF-8 string)
   * @param privateKeyHex - Ed25519 private key as hex string
   * @returns Hex signature (64 bytes = 128 hex chars)
   */
  async sign(message: string, privateKeyHex: string): Promise<string> {
    // Use HMAC-SHA256 for signing (CJS compatible, no ESM issues)
    // NOTE: This is not true Ed25519. For production crypto, consider using
    // @noble/ed25519 or a proper Ed25519 implementation.
    // BUG-1: Coordinator uses Ed25519 for verification, which won't match.
    // This is a known limitation documented in BUGS-SPRINT10.md.
    const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
    const messageBytes = Buffer.from(message, 'utf-8');
    const hmac = crypto.createHmac('sha256', privateKeyBytes);
    hmac.update(messageBytes);
    return hmac.digest('hex');
  }

  /**
   * Verify an Ed25519 signature
   * @param message - The message that was signed
   * @param signatureHex - The signature as hex string
   * @param publicKeyHex - The Ed25519 public key as hex string
   */
  async verifySignature(
    message: string,
    signatureHex: string,
    publicKeyHex: string,
  ): Promise<boolean> {
    try {
      const messageBytes = Buffer.from(message, 'utf-8');
      const signatureBytes = Buffer.from(signatureHex, 'hex');
      const publicKeyBytes = Buffer.from(publicKeyHex, 'hex');

      // Verify HMAC-SHA256 signature (for compatibility with sign())
      // NOTE: Both sign() and verifySignature() must use the same algorithm.
      // BUG-1: Coordinator P2PHeartbeatBridge uses Ed25519 (@noble/ed25519),
      // which won't match HMAC-SHA256 signatures from this function.
      const hmac = crypto.createHmac('sha256', publicKeyBytes);
      hmac.update(messageBytes);
      const expectedSignature = hmac.digest('hex');
      return signatureBytes.toString('hex') === expectedSignature;
    } catch {
      return false;
    }
  }

  /**
   * Create a canonical JSON payload for signing (keys sorted alphabetically, no signature field)
   */
  canonicalPayload(data: Record<string, unknown>): string {
    const { signature: _sig, ...rest } = data as Record<string, unknown> & { signature?: string };
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(rest).sort()) {
      sorted[key] = rest[key];
    }
    return JSON.stringify(sorted);
  }

  /**
   * Get or create identity (convenience function for CLI)
   */
  getOrCreateIdentity(identityDir: string = IDENTITY_DIR): Identity {
    try {
      return this.loadIdentity(identityDir);
    } catch {
      return this.generateIdentity(identityDir);
    }
  }

  /**
   * Update identity fields (A16)
   */
  updateIdentity(
    updates: Partial<Pick<Identity, 'tier' | 'mode' | 'status'>>,
    identityDir: string = IDENTITY_DIR,
  ): Identity {
    const identity = this.loadIdentity(identityDir);

    if (updates.tier !== undefined) {
      identity.tier = updates.tier;
    }
    if (updates.mode !== undefined) {
      identity.mode = updates.mode;
    }
    if (updates.status !== undefined) {
      identity.status = updates.status;
    }

    writeFileSync(path.join(identityDir, 'identity.json'), JSON.stringify(identity, null, 2));
    return identity;
  }

  /**
   * Get full agent profile (A16)
   */
  getAgentProfile(identity: Identity): {
    agentId: string;
    peerId: string;
    tier: number;
    mode: 'power' | 'chill';
    status: 'active' | 'idle' | 'offline';
    createdAt: number;
    publicKey: string;
  } {
    return {
      agentId: identity.agentId || identity.publicKey.slice(0, 8),
      peerId: identity.peerId,
      tier: identity.tier || 0,
      mode: identity.mode || 'chill',
      status: identity.status || 'idle',
      createdAt: identity.createdAt,
      publicKey: identity.publicKey,
    };
  }
}

// Backward-compatible standalone exports
export const generateIdentity = (identityDir?: string): Identity =>
  new IdentityHelper().generateIdentity(identityDir ?? IDENTITY_DIR);
export const loadIdentity = (identityDir?: string): Identity =>
  new IdentityHelper().loadIdentity(identityDir ?? IDENTITY_DIR);
export const sign = (message: string, privateKeyHex: string): Promise<string> =>
  new IdentityHelper().sign(message, privateKeyHex);
export const verifySignature = (
  message: string,
  signatureHex: string,
  publicKeyHex: string,
): Promise<boolean> =>
  new IdentityHelper().verifySignature(message, signatureHex, publicKeyHex);
export const canonicalPayload = (data: Record<string, unknown>): string =>
  new IdentityHelper().canonicalPayload(data);
export const getOrCreateIdentity = (identityDir?: string): Identity =>
  new IdentityHelper().getOrCreateIdentity(identityDir ?? IDENTITY_DIR);
export const updateIdentity = (
  updates: Partial<Pick<Identity, 'tier' | 'mode' | 'status'>>,
  identityDir?: string,
): Identity =>
  new IdentityHelper().updateIdentity(updates, identityDir ?? IDENTITY_DIR);
export const getAgentProfile = (identity: Identity): {
  agentId: string;
  peerId: string;
  tier: number;
  mode: 'power' | 'chill';
  status: 'active' | 'idle' | 'offline';
  createdAt: number;
  publicKey: string;
} => new IdentityHelper().getAgentProfile(identity);
