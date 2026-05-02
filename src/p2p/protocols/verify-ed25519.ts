/**
 * verify-ed25519.ts — Ed25519 signature verification using node's
 * native `crypto.verify`, kept identical to the coordinator-side helper
 * at `packages/coordinator/src/common/guards/ed25519-verify.ts` so both
 * sides agree on the SPKI wrapping.
 *
 * Plan: Tier-2 §2.2.2.
 */
import { verify, createPublicKey } from 'crypto';

/** ASN.1 DER prefix for Ed25519 SubjectPublicKeyInfo (SPKI). */
const ED25519_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verify an Ed25519 signature.
 *
 * @param publicKeyBytes - Raw 32-byte Ed25519 public key.
 * @param signatureBytes - 64-byte Ed25519 signature.
 * @param messageBytes   - The signed message payload.
 * @returns true when the signature is valid for the given pubkey + message.
 */
export function verifyEd25519(params: {
  publicKeyBytes: Uint8Array;
  signatureBytes: Uint8Array;
  messageBytes: Uint8Array;
}): boolean {
  const { publicKeyBytes, signatureBytes, messageBytes } = params;

  const publicKeyDer = Buffer.concat([
    ED25519_DER_PREFIX,
    Buffer.from(publicKeyBytes),
  ]);
  const keyObject = createPublicKey({
    key: publicKeyDer,
    format: 'der',
    type: 'spki',
  });

  return verify(null, Buffer.from(messageBytes), keyObject, Buffer.from(signatureBytes));
}
