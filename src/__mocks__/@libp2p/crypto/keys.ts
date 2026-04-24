// Mock for @libp2p/crypto/keys
import * as crypto from 'crypto';

const mockKey = {
  type: 'Ed25519',
  raw: new Uint8Array(32),
  public: { raw: new Uint8Array(32), type: 'Ed25519' },
};

export async function generateKeyPair(_type: string): Promise<typeof mockKey> {
  const { privateKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'der', type: 'pkcs8' },
    publicKeyEncoding: { format: 'der', type: 'spki' },
  });
  return { ...mockKey, raw: new Uint8Array(privateKey) };
}

export function privateKeyFromProtobuf(_bytes: Uint8Array): typeof mockKey {
  return { ...mockKey };
}

export function privateKeyToProtobuf(_key: typeof mockKey): Uint8Array {
  return new Uint8Array(64);
}
