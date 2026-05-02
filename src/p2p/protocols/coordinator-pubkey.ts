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

// Bitcoin/Solana base58 alphabet. Inlined instead of using `bs58` because
// that package's dependency chain (`bs58 → base-x → safe-buffer`) emits a
// dynamic `require('buffer')` that tsup's ESM bundle rejects at boot,
// silently falling back to the UNVERIFIED gossipsub handler. Node has a
// global `Buffer` so we never need the polyfill — a 25-line decoder is
// cheaper than fighting the bundler.
const ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = (() => {
  const map = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    map[ALPHABET.charCodeAt(i)] = i;
  }
  return map;
})();

function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  const bytes: number[] = [0];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const value = code < 128 ? ALPHABET_MAP[code] : -1;
    if (value < 0) {
      throw new Error(`Invalid base58 character "${input[i]}" at index ${i}`);
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading '1' chars in base58 = leading 0x00 bytes.
  for (let k = 0; k < input.length && input[k] === '1'; k++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
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
    decoded = base58Decode(raw);
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
