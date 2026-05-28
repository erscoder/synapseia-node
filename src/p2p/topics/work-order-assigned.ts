/**
 * work-order-assigned.ts — node-side handler for the signed,
 * shard-routed, TARGETED `WORK_ORDER_ASSIGNED` gossipsub envelope
 * published by the coordinator (D-P2P Slice 2, 2026-05-28).
 *
 * Wire format (`packages/coordinator/.../CoordinatorPublisher.ts ::
 * publishTargetedWorkOrder`):
 *   {
 *     payload: { targetPeerId, wo: { id, ... }, seq? },
 *     ts:      unix-seconds,
 *     sig:     base64(Ed25519(JSON.stringify({payload, ts})))
 *   }
 *
 * Published to `WORK_ORDER_ASSIGNED/shard/<shardOf(targetPeerId, K)>`.
 * Every node on that shard receives it; THIS handler keeps the WO IFF
 * `payload.targetPeerId === myPeerId`, else drops it (mirrors the
 * EVALUATION_ASSIGNMENTS `nodeId === myPeerId` filter in node-runtime.ts).
 *
 * Verification (sig + freshness + coord-pubkey trust anchor) is identical
 * to `work-order-available.ts` / `evaluation-assignments.ts` — same
 * Ed25519 verify, same `{payload, ts}` signed-bytes reconstruction, same
 * 60s freshness window, same fail-closed pubkey gating upstream.
 */
import logger from '../../utils/logger';
import {
  EXPECTED_COORD_PUBKEY_PREFIX,
  WARN_THROTTLE_SECONDS,
  checkMismatchCrisis,
  recordVerify,
  shouldEmitWarn,
} from '../protocols/coord-sig-stats';
import { verifyEd25519 } from '../protocols/verify-ed25519';

const COORD_TOPIC = 'WORK_ORDER_ASSIGNED';

function emitInvalidSigWarn(warn: (m: string) => void, sig: unknown): void {
  const sigPrefix =
    typeof sig === 'string' && sig.length > 0 ? sig.slice(0, 8) : 'no-sig';
  recordVerify(COORD_TOPIC, sigPrefix, false);
  const decision = shouldEmitWarn(COORD_TOPIC, sigPrefix);
  if (decision.emit) {
    const suffix =
      decision.suppressed > 0
        ? ` (+${decision.suppressed} suppressed in last ${WARN_THROTTLE_SECONDS}s)`
        : '';
    warn(
      `[WO-Assigned-Verify] invalid signature ` +
        `(sigPrefix=${sigPrefix}, expectedPubkey=${EXPECTED_COORD_PUBKEY_PREFIX}…)${suffix}`,
    );
  }
  const crisis = checkMismatchCrisis();
  if (crisis) logger.error(crisis);
}

const ANSI_CTRL_RE = /[\r\n\x1b]/g;

function sanitize(s: string): string {
  return s.replace(ANSI_CTRL_RE, '?');
}

/** The inner work order the coordinator forwards. Open shape — mirrors
 *  `work-order-available.ts :: IncomingWorkOrder`. */
export interface IncomingAssignedWorkOrder {
  id: string;
  [key: string]: unknown;
}

export interface HandleAssignedArgs {
  /** Raw 32-byte Ed25519 pubkey from `loadCoordinatorPubkey`. */
  pubkey: Uint8Array;
  /** Raw gossipsub message bytes (the full signed-envelope JSON). */
  msg: Uint8Array;
  /** THIS node's peerId. The envelope is kept iff it equals
   *  `payload.targetPeerId`. */
  myPeerId: string;
  /** Called once per verified, fresh, well-formed, *targeted-at-me* WO. */
  consumer: (wo: IncomingAssignedWorkOrder) => Promise<void> | void;
  /** Override warn sink (defaults to project logger.warn). */
  warn?: (msg: string) => void;
  /** Override clock source (defaults to Date.now). Returns ms-epoch. */
  now?: () => number;
  /** Reject when `ts` is older than this. Defaults to 60s. */
  freshnessWindowSec?: number;
}

interface ParsedEnvelope {
  payload: unknown;
  ts: unknown;
  sig: unknown;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function parseEnvelope(msg: Uint8Array): ParsedEnvelope | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(msg));
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  if (!('payload' in raw) || !('ts' in raw) || !('sig' in raw)) return null;
  return { payload: raw.payload, ts: raw.ts, sig: raw.sig };
}

export async function handleWorkOrderAssigned(
  args: HandleAssignedArgs,
): Promise<void> {
  const warn = args.warn ?? ((m: string) => logger.warn(m));
  const now = args.now ?? Date.now;
  const freshnessWindowSec = args.freshnessWindowSec ?? 60;

  // 1. Parse + shape check ------------------------------------------------
  const envelope = parseEnvelope(args.msg);
  if (!envelope) {
    warn('[WO-Assigned-Verify] invalid envelope shape');
    return;
  }

  const { payload, ts, sig } = envelope;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    warn('[WO-Assigned-Verify] invalid envelope shape (ts)');
    return;
  }
  if (typeof sig !== 'string' || sig.length === 0) {
    warn('[WO-Assigned-Verify] invalid envelope shape (sig)');
    return;
  }
  if (!isObject(payload)) {
    warn('[WO-Assigned-Verify] invalid envelope shape (payload)');
    return;
  }

  // 2. Verify signature against `JSON.stringify({payload, ts})` -----------
  // Same key order the publisher used: `{ payload, ts }` (see
  // CoordinatorPublisher.publishTargetedWorkOrder).
  const signedBytes = new TextEncoder().encode(JSON.stringify({ payload, ts }));
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(sig, 'base64');
  } catch {
    emitInvalidSigWarn(warn, sig);
    return;
  }
  if (signatureBytes.length !== 64) {
    emitInvalidSigWarn(warn, sig);
    return;
  }

  let ok = false;
  try {
    ok = verifyEd25519({
      publicKeyBytes: args.pubkey,
      signatureBytes,
      messageBytes: signedBytes,
    });
  } catch {
    ok = false;
  }
  if (!ok) {
    emitInvalidSigWarn(warn, sig);
    return;
  }

  // Verify success — feed the rolling window (see WO-available handler).
  {
    const sigPrefix =
      typeof sig === 'string' && sig.length > 0 ? sig.slice(0, 8) : 'no-sig';
    recordVerify(COORD_TOPIC, sigPrefix, true);
  }

  // 3. Freshness check ----------------------------------------------------
  const ageSec = Math.floor(now() / 1000) - ts;
  if (ageSec > freshnessWindowSec) {
    warn(
      `[WO-Assigned-Verify] stale envelope (age=${ageSec}s > ${freshnessWindowSec}s)`,
    );
    return;
  }

  // 4. Targeting filter — keep IFF targetPeerId === myPeerId -------------
  const targetPeerId = (payload as { targetPeerId?: unknown }).targetPeerId;
  if (typeof targetPeerId !== 'string' || targetPeerId.length === 0) {
    warn('[WO-Assigned-Verify] missing payload.targetPeerId');
    return;
  }
  if (targetPeerId !== args.myPeerId) {
    // Not for me — every node on the shard receives the envelope; only the
    // target keeps it. Debug only (this is the common case for K=1).
    logger.debug?.(
      `[WO-Assigned] dropped, not my target (target=${sanitize(
        targetPeerId.slice(0, 12),
      )}…)`,
    );
    return;
  }

  // 5. Post-verify inner-WO shape ----------------------------------------
  const wo = (payload as { wo?: unknown }).wo;
  if (!isObject(wo)) {
    warn('[WO-Assigned-Verify] invalid payload.wo');
    return;
  }
  const id = (wo as { id?: unknown }).id;
  if (typeof id !== 'string' || id.length === 0) {
    warn('[WO-Assigned-Verify] missing wo.id');
    return;
  }

  // 6. Hand off to consumer ----------------------------------------------
  try {
    await args.consumer(wo as IncomingAssignedWorkOrder);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    warn(`[WO-Assigned-Verify] consumer threw: ${sanitize(m)}`);
  }
}
