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
 *     sig:     base64(Ed25519(signed-bytes))
 *   }
 *
 * The signed bytes are `JSON.stringify({ domain:
 * 'synapseia/gossip/work-order-assigned/v1', body: payload, ts })`
 * (coordinator `signedEnvelopeBytes` helper), NOT the wire envelope. The
 * domain tag is never on the wire — the node supplies it per-handler via
 * `verifyCoordinatorEnvelope`. This is what makes a WORK_ORDER_ASSIGNED
 * signature DISTINCT from an EVALUATION_ASSIGNMENTS one even though both wire
 * envelopes share the `{ payload, ts, sig }` shape (cross-type replay fix).
 *
 * Published to `WORK_ORDER_ASSIGNED/shard/<shardOf(targetPeerId, K)>`.
 * Every node on that shard receives it; THIS handler keeps the WO IFF
 * `payload.targetPeerId === myPeerId`, else drops it (mirrors the
 * EVALUATION_ASSIGNMENTS `nodeId === myPeerId` filter in node-runtime.ts).
 *
 * Verification (sig + freshness + replay + coord-pubkey trust anchor) goes
 * through the SHARED `verifyCoordinatorEnvelope` helper that
 * `work-order-available.ts` / `evaluation-assignments.ts` also use — same
 * Ed25519 verify, same 60s freshness window, same fail-closed pubkey gating
 * upstream, differing ONLY in the domain constant.
 */
import logger from '../../utils/logger';
import {
  EXPECTED_COORD_PUBKEY_PREFIX,
  WARN_THROTTLE_SECONDS,
  checkMismatchCrisis,
  recordVerify,
  shouldEmitWarn,
} from '../protocols/coord-sig-stats';
import type { ReplayGuard } from './replay-guard';
import {
  DOMAIN_WO_ASSIGNED,
  verifyCoordinatorEnvelope,
} from './verify-coordinator-envelope';

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
  /**
   * Optional bounded replay guard (one per topic, wired at the dispatch
   * site). When provided, a signature already seen within the freshness
   * window is rejected (warn + return) instead of forwarded.
   */
  replayGuard?: ReplayGuard;
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

  // 2. Verify signature + freshness + replay via the shared helper -------
  // `verifyCoordinatorEnvelope` reconstructs the coordinator's signed bytes
  // `JSON.stringify({ domain, body, ts })` (domain = DOMAIN_WO_ASSIGNED,
  // body = payload). The domain tag (supplied here, never read from the
  // wire) is what makes this signature DISTINCT from an EVALUATION_ASSIGNMENTS
  // one even though both carry an identical `{ payload, ts }` wire shape —
  // this closes the cross-type signature replay.
  const result = verifyCoordinatorEnvelope({
    domain: DOMAIN_WO_ASSIGNED,
    body: payload,
    ts,
    sigBase64: sig,
    coordinatorPubkey: args.pubkey,
    now: now(),
    freshnessWindowSec,
    replayGuard: args.replayGuard,
  });

  if (!result.ok) {
    if (result.reason === 'stale') {
      const ageSec = Math.floor(now() / 1000) - ts;
      warn(
        `[WO-Assigned-Verify] stale envelope (age=${ageSec}s > ${freshnessWindowSec}s)`,
      );
      return;
    }
    if (result.reason === 'replayed') {
      warn(
        `[WO-Assigned-Verify] replayed envelope dropped (sigPrefix=${sig.slice(0, 8)})`,
      );
      return;
    }
    emitInvalidSigWarn(warn, sig);
    return;
  }

  // Verify success — feed the rolling window (see WO-available handler).
  {
    const sigPrefix = sig.length > 0 ? sig.slice(0, 8) : 'no-sig';
    recordVerify(COORD_TOPIC, sigPrefix, true);
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
