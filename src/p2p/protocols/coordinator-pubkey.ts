/**
 * coordinator-pubkey.ts — trust-anchor for signed coordinator
 * gossipsub envelopes.
 *
 * The coordinator signs every `WORK_ORDER_AVAILABLE`,
 * `EVALUATION_ASSIGNMENTS`, `KG_SHARD_OWNERSHIP`, and
 * `KG_QUERY_REDIRECT` envelope with its Ed25519 identity key (see
 * `packages/coordinator/src/infrastructure/p2p/CoordinatorIdentityService.ts`).
 * Worker nodes verify each envelope against the matching public key,
 * which is hardcoded BELOW as a base58 constant.
 *
 * Why a constant instead of an env var:
 *   - The pubkey is public by definition; no secret to hide.
 *   - Embedding it in source means the trust anchor is versioned in
 *     git (audit trail) and ships inside the DMG without any setup
 *     ceremony — operators don't need to set an env var, the UI
 *     doesn't need a settings panel.
 *   - Rotation is a release event: replace the constant, bump the
 *     minor version, rebuild + redistribute. That's the right
 *     ceremony for a trust-anchor change.
 *
 * To rotate (or set up a new network):
 *   1. From `packages/coordinator`, `npm run gen:coord-keys` (one-shot
 *      generator script — present only when keys are being rotated).
 *   2. Paste `COORDINATOR_PRIVKEY_BASE58=…` into the coord `.env`
 *      (gitignored).
 *   3. Paste the new `COORDINATOR_PUBKEY_BASE58` value into the
 *      `COORDINATOR_PUBKEY_BASE58` constant below and commit.
 *   4. Bump coord/node/node-ui/dashboard minor version
 *      (memory `feedback_version_management`).
 *   5. Rebuild DMG + redistribute.
 *
 * Plan: Tier-2 §2.2.1, refined in plan D dev cleanup (2026-05-03).
 */

/** Hardcoded Ed25519 trust anchor — coord public key, base58 (32-byte
 *  raw key, Solana/Bitcoin alphabet). Generated alongside the matching
 *  `COORDINATOR_PRIVKEY_BASE58` that lives in the coord container's
 *  `.env`. Public — safe to commit. */
export const COORDINATOR_PUBKEY_BASE58 =
  'FxN9BaT4ktzV79tvnQvnJZQiUharE9oWi8FXixDwV4V1';

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
 * Decode and validate the hardcoded coordinator Ed25519 public key.
 *
 * Returns the raw 32-byte pubkey ready for `crypto.verify`. Throws on
 * the off-chance someone hand-edited `COORDINATOR_PUBKEY_BASE58` to a
 * value that doesn't decode to 32 bytes — that's a corrupted release,
 * not a runtime concern.
 */
export function loadCoordinatorPubkey(): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = base58Decode(COORDINATOR_PUBKEY_BASE58);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `COORDINATOR_PUBKEY_BASE58 constant is not a valid base58 string: ${msg}`,
    );
  }

  if (decoded.length !== ED25519_RAW_PUBKEY_LEN) {
    throw new Error(
      `COORDINATOR_PUBKEY_BASE58 constant must decode to exactly ${ED25519_RAW_PUBKEY_LEN} bytes ` +
        `(raw Ed25519 pubkey); got ${decoded.length}`,
    );
  }

  return decoded;
}
