// Mock for @noble/ed25519 backed by Node's built-in crypto.
//
// Rationale: @noble's published ESM breaks ts-jest; we still need a real
// cryptographic contract for tests that sign + verify (see node-auth.spec).
// Node's crypto.sign / crypto.verify produce byte-identical Ed25519
// signatures to the real @noble lib, so downstream tests can pair:
//   - sign via this mock (called from node-auth.ts)
//   - verify via crypto.verify directly (test-side)
//
// Keeps the mock small: only the surface node-auth.ts actually imports is
// backed; the other named exports are lightweight stubs left in place in
// case another module imports them (none do today, but removing them
// would surface silent mock hits through an undefined export).

import * as crypto from 'crypto';

const PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');

function privKeyFrom(raw: Uint8Array): crypto.KeyObject {
  const der = Buffer.concat([PKCS8_HEADER, Buffer.from(raw)]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}
function pubKeyFrom(raw: Uint8Array): crypto.KeyObject {
  const der = Buffer.concat([SPKI_HEADER, Buffer.from(raw)]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function sign(msg: Uint8Array, privKey: Uint8Array): Uint8Array {
  return new Uint8Array(crypto.sign(null, Buffer.from(msg), privKeyFrom(privKey)));
}
export async function signAsync(msg: Uint8Array, privKey: Uint8Array): Promise<Uint8Array> {
  return sign(msg, privKey);
}

export function verify(sig: Uint8Array, msg: Uint8Array, pubKey: Uint8Array): boolean {
  return crypto.verify(null, Buffer.from(msg), pubKeyFrom(pubKey), Buffer.from(sig));
}
export async function verifyAsync(sig: Uint8Array, msg: Uint8Array, pubKey: Uint8Array): Promise<boolean> {
  return verify(sig, msg, pubKey);
}

export function getPublicKey(privKey: Uint8Array): Uint8Array {
  const { publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'der', type: 'pkcs8' },
    publicKeyEncoding: { format: 'der', type: 'spki' },
  });
  // For determinism, derive the public key from the given private key.
  const privObj = privKeyFrom(privKey);
  const pubDer = crypto.createPublicKey(privObj).export({ format: 'der', type: 'spki' }) as Buffer;
  void publicKey;
  return new Uint8Array(pubDer.subarray(-32));
}
export async function getPublicKeyAsync(privKey: Uint8Array): Promise<Uint8Array> {
  return getPublicKey(privKey);
}

export const utils = {
  randomPrivateKey(): Uint8Array {
    const { privateKey } = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { format: 'der', type: 'pkcs8' },
      publicKeyEncoding: { format: 'der', type: 'spki' },
    });
    const der = privateKey as Buffer;
    return new Uint8Array(der.subarray(-32));
  },
};

export const Point = {};
export const ExtendedPoint = {};
export const ed25519_CURVE = {};
export const etc: { sha512Sync?: (...msgs: Uint8Array[]) => Uint8Array } = {};
export const hashes: { sha512?: unknown } = {};
