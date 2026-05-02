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

const ENV_NAME = 'SYNAPSEIA_COORDINATOR_PUBKEY_BASE58';
const ED25519_RAW_PUBKEY_LEN = 32;

let bs58Cache: { encode: (b: Uint8Array) => string; decode: (s: string) => Uint8Array } | null =
  null;

function getBs58(): {
  encode: (b: Uint8Array) => string;
  decode: (s: string) => Uint8Array;
} {
  if (bs58Cache) return bs58Cache;
  // Lazy `require` keeps this loader synchronous (matches the plan API)
  // while still picking bs58 up from the hoisted root `node_modules/`.
  // bs58 ships both CJS and ESM; default-export is the API object.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('bs58');
  bs58Cache = (mod.default ?? mod) as {
    encode: (b: Uint8Array) => string;
    decode: (s: string) => Uint8Array;
  };
  return bs58Cache;
}

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
    decoded = getBs58().decode(raw);
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
