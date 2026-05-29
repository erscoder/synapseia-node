// Mock for @libp2p/crypto/keys
//
// FIDELITY CONTRACT (fixes the prior vacuous mock): the persistence path
// in p2p.ts (`loadOrCreateKey`) does generate → privateKeyToProtobuf →
// write hex → read hex → privateKeyFromProtobuf, and the WHOLE point of
// persisting is that the peerId stays stable across restarts. The old
// mock returned a static zero key and a fixed 64-zero protobuf that
// ignored its input, so `load(save(k))` could NEVER reconstruct `k` and
// any persistence/peerId-stability test was silently vacuous.
//
// This mock round-trips faithfully: the protobuf encoding carries the
// real 32-byte raw private scalar, and decode re-derives the matching
// public key from it (via Node crypto), so:
//   privateKeyFromProtobuf(privateKeyToProtobuf(k))  ≡  k
// (same `.raw` private bytes AND same `.public.raw` public bytes).
import * as crypto from 'crypto';

const PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface MockPrivateKey {
  type: 'Ed25519';
  raw: Uint8Array; // raw 32-byte private scalar
  public: { raw: Uint8Array; type: 'Ed25519' };
}

/** Derive the raw 32-byte Ed25519 public key from a raw 32-byte private scalar. */
function derivePublicRaw(privRaw: Uint8Array): Uint8Array {
  const der = Buffer.concat([PKCS8_HEADER, Buffer.from(privRaw)]);
  const privObj = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pubDer = crypto.createPublicKey(privObj).export({ format: 'der', type: 'spki' }) as Buffer;
  return new Uint8Array(pubDer.subarray(-32));
}

function makeKey(privRaw: Uint8Array): MockPrivateKey {
  const raw = new Uint8Array(privRaw);
  return {
    type: 'Ed25519',
    raw,
    public: { raw: derivePublicRaw(raw), type: 'Ed25519' },
  };
}

export async function generateKeyPair(_type: string): Promise<MockPrivateKey> {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  // Export raw 32-byte private scalar (last 32 bytes of the PKCS8 DER).
  const privRaw = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32);
  return makeKey(new Uint8Array(privRaw));
}

// Minimal, faithful round-trip encoding: the protobuf body is just the
// raw 32-byte private scalar (the real libp2p protobuf additionally tags
// the key type, but the only key type this mock produces is Ed25519, so
// the scalar alone is a lossless representation for the round-trip the
// tests exercise).
export function privateKeyToProtobuf(key: MockPrivateKey): Uint8Array {
  return new Uint8Array(key.raw);
}

export function privateKeyFromProtobuf(bytes: Uint8Array): MockPrivateKey {
  // Accept exactly the 32-byte scalar produced by privateKeyToProtobuf.
  // A wrong length means a corrupted/foreign key file — surface it loudly
  // rather than silently returning a zero key (the old mock's landmine).
  if (bytes.length !== 32) {
    throw new Error(
      `mock privateKeyFromProtobuf: expected 32-byte raw Ed25519 scalar, got ${bytes.length}`,
    );
  }
  return makeKey(bytes);
}
