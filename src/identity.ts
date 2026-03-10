import { Keypair } from '@solana/web3.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface Identity {
  peerId: string;
  privateKey: string;
  publicKey: string;
}

export async function generateIdentity(): Promise<Identity> {
  const keypair = Keypair.generate();

  // PeerID is base64 of publicKey (simplified format)
  const peerId = Buffer.from(keypair.publicKey.toBytes()).toString('base64');

  return {
    peerId,
    privateKey: Buffer.from(keypair.secretKey).toString('base64'),
    publicKey: Buffer.from(keypair.publicKey.toBytes()).toString('base64'),
  };
}

export async function saveIdentity(identity: Identity): Promise<void> {
  const configDir = path.join(os.homedir(), '.synapseia');
  await fs.mkdir(configDir, { recursive: true });

  const identityPath = path.join(configDir, 'identity.json');
  await fs.writeFile(identityPath, JSON.stringify(identity, null, 2));
}

export async function loadIdentity(): Promise<Identity | null> {
  const identityPath = path.join(os.homedir(), '.synapseia', 'identity.json');

  try {
    const data = await fs.readFile(identityPath, 'utf-8');
    const identity = JSON.parse(data) as Identity;
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function getOrCreateIdentity(): Promise<Identity> {
  let identity = await loadIdentity();

  if (!identity) {
    identity = await generateIdentity();
    await saveIdentity(identity);
  }

  return identity;
}
