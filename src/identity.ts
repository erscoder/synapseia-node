/**
 * Identity management for Synapse nodes
 * Simple keypair for signing and authentication
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export interface Identity {
  peerId: string;        // SHA256(pubkey)[0..32] hex
  publicKey: string;     // Hex string
  privateKey: string;    // Hex string
  createdAt: number;     // Timestamp
  agentId?: string;      // First 8 chars of publicKey (NEW A16)
  tier?: number;         // Number (NEW A16)
  mode?: 'power' | 'chill';  // Operating mode (NEW A16)
  status?: 'active' | 'idle' | 'offline';  // Node status (NEW A16)
}

const IDENTITY_DIR = path.join(os.homedir(), '.synapse');
const IDENTITY_FILE = path.join(IDENTITY_DIR, 'identity.json');

/**
 * Generate new identity keypair
 */
export function generateIdentity(identityDir: string = IDENTITY_DIR): Identity {
  if (!existsSync(identityDir)) {
    mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  }

  // Generate random keypair (32 bytes each)
  const privateKey = crypto.randomBytes(32);
  const privateKeyHex = privateKey.toString('hex');

  // Derive public key (for now just use a derived value - will upgrade to proper PKI later)
  const hash = crypto.createHash('sha256').update(privateKey).digest();
  const publicKeyHex = hash.toString('hex');

  // Derive peerId from public key (first 32 chars of SHA256)
  const peerIdHash = crypto.createHash('sha256').update(publicKeyHex, 'hex').digest('hex');
  const peerId = peerIdHash.slice(0, 32); // 128 bits / 4 = 32 chars

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
export function loadIdentity(identityDir: string = IDENTITY_DIR): Identity {
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
 * Sign a message with the node's private key
 */
export function sign(message: string, privateKeyHex: string): string {
  const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
  const messageBytes = Buffer.from(message, 'utf-8');
  const hmac = crypto.createHmac('sha256', privateKeyBytes);
  hmac.update(messageBytes);
  const signature = hmac.digest('hex');
  return signature;
}

/**
 * Get or create identity (convenience function for CLI)
 */
export function getOrCreateIdentity(identityDir: string = IDENTITY_DIR): Identity {
  return loadIdentity(identityDir) || generateIdentity(identityDir);
}

/**
 * Update identity fields (A16)
 */
export function updateIdentity(
  updates: Partial<Pick<Identity, 'tier' | 'mode' | 'status'>>,
  identityDir: string = IDENTITY_DIR,
): Identity {
  const identity = loadIdentity(identityDir);

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
export function getAgentProfile(identity: Identity): {
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
