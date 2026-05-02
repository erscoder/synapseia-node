/**
 * coordinator-pubkey.ts — trust-anchor loader for signed coordinator
 * gossipsub envelopes.
 *
 * The coordinator signs every `WORK_ORDER_AVAILABLE` envelope with its
 * Ed25519 identity key (see
 * `packages/coordinator/src/infrastructure/p2p/CoordinatorPublisher.ts`).
 * Worker nodes verify each envelope with the matching public key,
 * supplied at boot via the `SYNAPSEIA_COORDINATOR_PUBKEY_BASE58`
 * environment variable.
 *
 * Plan: Tier-2 §2.2.1.
 */

// Static ESM import. The previous lazy `require('bs58')` worked in jest
// (CommonJS) but raised `Dynamic require of "buffer" is not supported`
// in the tsup-bundled ESM node runtime, falling back to the UNVERIFIED
// gossipsub handler — which silently disables the T2.2 trust check.
import bs58 from 'bs58';

const ENV_NAME = 'SYNAPSEIA_COORDINATOR_PUBKEY_BASE58';
const ED25519_RAW_PUBKEY_LEN = 32;

/**
 * Decode and validate the coordinator's Ed25519 public key.
 *
 * @throws Error when `pubkeyBase58` is unset/empty or decodes to a
 *   payload other than 32 bytes (raw Ed25519 pubkey length).
 */
export function loadCoordinatorPubkey(opts: {
  pubkeyBase58: string | undefined | null;
}): Uint8Array {
  const raw = opts.pubkeyBase58;
  if (raw === undefined || raw === null || raw === '') {
    throw new Error(
      `${ENV_NAME} is required to verify signed coordinator gossipsub envelopes`,
    );
  }

  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${ENV_NAME} is not a valid base58 string: ${msg}`);
  }

  if (decoded.length !== ED25519_RAW_PUBKEY_LEN) {
    throw new Error(
      `${ENV_NAME} must decode to exactly ${ED25519_RAW_PUBKEY_LEN} bytes ` +
        `(raw Ed25519 pubkey); got ${decoded.length}`,
    );
  }

  return decoded;
}
