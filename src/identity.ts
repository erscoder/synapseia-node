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

  const identity: Identity = {
    peerId,
    publicKey: publicKeyHex,
    privateKey: privateKeyHex,
    createdAt: Date.now(),
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
