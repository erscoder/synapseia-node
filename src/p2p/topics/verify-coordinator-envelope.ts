/**
 * verify-coordinator-envelope.ts — SINGLE source of truth for verifying a
 * coordinator-signed gossip envelope on the node side.
 *
 * The coordinator computes its signed bytes via the private
 * `signedEnvelopeBytes(domain, body, ts)` helper in
 * `packages/coordinator/src/infrastructure/p2p/CoordinatorPublisher.ts`:
 *
 *   new TextEncoder().encode(JSON.stringify({ domain, body, ts }))   // key order domain, body, ts
 *
 * This helper reconstructs those EXACT bytes and verifies the Ed25519
 * signature against the trusted coordinator pubkey, then applies the
 * freshness window and (when provided) the replay check. The three topic
 * handlers (`work-order-available` → body = wo; `work-order-assigned` +
 * `evaluation-assignments` → body = payload) all route through here with
 * their own domain constant, so the signed-bytes format lives in exactly
 * one place on the node side and mirrors the coordinator helper.
 *
 * Domain separation: the `domain` tag is supplied PER-HANDLER (it is never
 * read from the wire), so a signature minted for one message type cannot be
 * replayed against another — the reconstructed bytes differ on the domain
 * string and Ed25519 verification fails. This closes the cross-type
 * signature replay between WORK_ORDER_ASSIGNED and EVALUATION_ASSIGNMENTS
 * (which both carry an identical `{ payload, ts }` wire shape).
 *
 * We deliberately do NOT canonicalise / key-sort: the wrapper
 * `{ domain, body, ts }` is a fixed-shape literal and `body` is re-stringified
 * from the already-parsed wire object, so insertion-order parity with the
 * coordinator holds by construction. A recursive key-sorter would only add a
 * second place where the two sides could drift. The shared test vector
 * (asserted on BOTH sides with the same expected hex) pins the wrapper shape
 * and resolves the audit "canonical JSON" point.
 */
import { verifyEd25519 } from '../protocols/verify-ed25519';
import type { ReplayGuard } from './replay-guard';

/**
 * Domain-separation tags — MUST stay byte-identical to the coordinator-side
 * constants in
 * `packages/coordinator/src/infrastructure/p2p/CoordinatorPublisher.ts`
 * (`DOMAIN_WO_AVAILABLE` / `DOMAIN_WO_ASSIGNED` / `DOMAIN_EVAL_ASSIGNMENTS`).
 * If either side changes, the shared-vector hex test fails on both.
 */
export const DOMAIN_WO_AVAILABLE = 'synapseia/gossip/work-order-available/v1';
export const DOMAIN_WO_ASSIGNED = 'synapseia/gossip/work-order-assigned/v1';
export const DOMAIN_EVAL_ASSIGNMENTS = 'synapseia/gossip/evaluation-assignments/v1';

export interface VerifyCoordinatorEnvelopeArgs {
  /** Per-handler domain tag (NOT read from the wire). */
  domain: string;
  /** The verified body object — `wo` (available) or `payload` (assigned/eval). */
  body: unknown;
  /** Envelope timestamp, unix-seconds. */
  ts: number;
  /** Base64-encoded Ed25519 signature from the wire envelope. */
  sigBase64: string;
  /** Trusted coordinator pubkey (raw 32-byte Ed25519). */
  coordinatorPubkey: Uint8Array;
  /** Current wall-clock, ms-epoch (caller passes its clock source). */
  now: number;
  /** Reject when `ts` is older than this many seconds. */
  freshnessWindowSec: number;
  /**
   * Optional bounded replay guard. When provided, a signature already seen
   * within the freshness window is rejected (`reason: 'replayed'`). The guard
   * records-and-returns, so the FIRST call for a given sig passes and the
   * second is rejected.
   */
  replayGuard?: ReplayGuard;
}

export type VerifyReason =
  | 'bad-signature-encoding'
  | 'invalid-signature'
  | 'stale'
  | 'replayed';

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyReason;
}

/**
 * Verify a coordinator-signed envelope. Order of checks:
 *   1. decode the base64 signature (must be 64 bytes)
 *   2. Ed25519 verify reconstructed `{ domain, body, ts }` bytes
 *   3. freshness window
 *   4. replay guard (only after the signature is proven valid, so a forged
 *      sig never pollutes the guard's seen-set)
 *
 * Returns `{ ok: true }` on success, else `{ ok: false, reason }`.
 */
export function verifyCoordinatorEnvelope(
  args: VerifyCoordinatorEnvelopeArgs,
): VerifyResult {
  const { domain, body, ts, sigBase64, coordinatorPubkey, now } = args;

  // 1. Reconstruct the signed bytes — byte-identical to the coordinator
  //    `signedEnvelopeBytes(domain, body, ts)` helper.
  const signedBytes = new TextEncoder().encode(
    JSON.stringify({ domain, body, ts }),
  );

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(sigBase64, 'base64');
  } catch {
    return { ok: false, reason: 'bad-signature-encoding' };
  }
  if (signatureBytes.length !== 64) {
    return { ok: false, reason: 'bad-signature-encoding' };
  }

  // 2. Ed25519 verify.
  let valid = false;
  try {
    valid = verifyEd25519({
      publicKeyBytes: coordinatorPubkey,
      signatureBytes,
      messageBytes: signedBytes,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, reason: 'invalid-signature' };
  }

  // 3. Freshness window.
  const ageSec = Math.floor(now / 1000) - ts;
  if (ageSec > args.freshnessWindowSec) {
    return { ok: false, reason: 'stale' };
  }

  // 4. Replay guard — only AFTER the signature is proven valid + fresh, so a
  //    forged or stale envelope never records an entry in the seen-set.
  if (args.replayGuard && args.replayGuard.seenBefore(sigBase64, now)) {
    return { ok: false, reason: 'replayed' };
  }

  return { ok: true };
}
