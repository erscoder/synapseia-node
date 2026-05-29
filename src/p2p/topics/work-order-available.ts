/**
 * work-order-available.ts — node-side handler for the signed
 * `WORK_ORDER_AVAILABLE` gossipsub envelope published by the
 * coordinator.
 *
 * Wire format (`packages/coordinator/.../CoordinatorPublisher.ts`):
 *   {
 *     wo:  WorkOrderEnvelopePayload,   // see type below
 *     ts:  unix-seconds,
 *     sig: base64(Ed25519(signed-bytes))
 *   }
 *
 * The signed bytes are NOT the wire envelope — they are
 * `JSON.stringify({ domain: 'synapseia/gossip/work-order-available/v1',
 * body: wo, ts })` computed by the coordinator's `signedEnvelopeBytes`
 * helper and reconstructed here by `verifyCoordinatorEnvelope`. The domain
 * tag is never on the wire (the node supplies it per-handler), which closes
 * cross-type signature replay.
 *
 * The `wo` object mirrors the coordinator's `WorkOrderResponseDto`
 * (`toResponseDto`) and is consumed VERBATIM downstream — pushed into
 * `WorkOrderPushQueue` and mapped by `pushedToWorkOrder` into the
 * LangGraph `WorkOrder`. Signature verification proves the envelope came
 * from the coordinator, but it does NOT prove the payload is shaped the
 * way execution needs. A signed-but-malformed `wo` (missing
 * `rewardAmount` / `requiredCapabilities` / `status`, or a non-array
 * `requiredCapabilities`) would queue a half-specified WO that breaks
 * downstream capability matching and reward math. So after the signature
 * check we validate the REQUIRED execution fields and DROP+warn on any
 * missing/malformed one (reject-and-log; we never try to repair).
 *
 * Plan: Tier-2 §2.2.2.
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
  DOMAIN_WO_AVAILABLE,
  verifyCoordinatorEnvelope,
} from './verify-coordinator-envelope';

const COORD_TOPIC = 'WORK_ORDER_AVAILABLE';

function emitInvalidSigWarn(
  warn: (m: string) => void,
  sig: unknown,
): void {
  const sigPrefix = typeof sig === 'string' && sig.length > 0
    ? sig.slice(0, 8)
    : 'no-sig';
  recordVerify(COORD_TOPIC, sigPrefix, false);
  const decision = shouldEmitWarn(COORD_TOPIC, sigPrefix);
  if (decision.emit) {
    const suffix = decision.suppressed > 0
      ? ` (+${decision.suppressed} suppressed in last ${WARN_THROTTLE_SECONDS}s)`
      : '';
    warn(
      `[WO-Verify] invalid signature ` +
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

/**
 * Shape of the `wo` field inside a verified `WORK_ORDER_AVAILABLE`
 * envelope. Mirrors the coordinator `WorkOrderResponseDto`
 * (`toResponseDto`); only the fields that execution actually requires are
 * declared explicitly so the contract is enforceable post-verify. Extra
 * coordinator fields flow through via the index signature.
 *
 * The fields below are the ones `validateWorkOrderPayload` guarantees are
 * present + well-typed before the consumer is invoked:
 *   - `id`                   non-empty string (queue key)
 *   - `title`                non-empty string
 *   - `status`               non-empty string (execution routing)
 *   - `rewardAmount`         non-empty string (reward / profit math)
 *   - `requiredCapabilities` string[] (capability matching)
 *   - `creatorAddress`       non-empty string
 *   - `type`                 optional, but a string when present
 */
export interface WorkOrderEnvelopePayload {
  id: string;
  title: string;
  status: string;
  rewardAmount: string;
  requiredCapabilities: string[];
  creatorAddress: string;
  type?: string;
  missionId?: string;
  payload?: unknown;
  // Allow extra fields the coordinator forwards (e.g. metadata, seq, …)
  // without forcing the consumer to relax its own type.
  [key: string]: unknown;
}

/** @deprecated Prefer {@link WorkOrderEnvelopePayload}. Kept as an alias
 *  so existing importers (`work-order-assigned.ts`) compile unchanged. */
export type IncomingWorkOrder = WorkOrderEnvelopePayload;

export interface HandleWOArgs {
  /** Raw 32-byte Ed25519 pubkey from `loadCoordinatorPubkey`. */
  pubkey: Uint8Array;
  /** Raw gossipsub message bytes (the full signed-envelope JSON). */
  msg: Uint8Array;
  /** Called once per verified, fresh, well-formed WO. */
  consumer: (wo: IncomingWorkOrder) => Promise<void> | void;
  /** Override warn sink (defaults to project logger.warn). */
  warn?: (msg: string) => void;
  /** Override clock source (defaults to Date.now). Returns ms-epoch. */
  now?: () => number;
  /** Reject when `ts` is older than this. Defaults to 60s. */
  freshnessWindowSec?: number;
  /**
   * Optional bounded replay guard (one per topic, wired at the dispatch
   * site). When provided, a signature already seen within the freshness
   * window is rejected (warn + return) instead of re-queued.
   */
  replayGuard?: ReplayGuard;
}

interface ParsedEnvelope {
  wo: unknown;
  ts: unknown;
  sig: unknown;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

/**
 * Validate a signature-verified `wo` against the fields execution
 * actually consumes (`WorkOrderPushQueue` → `pushedToWorkOrder` →
 * LangGraph `WorkOrder`). Returns `null` when the payload is complete and
 * well-typed; otherwise returns a short reason string naming the first
 * offending field so the caller can DROP+warn. Defensive only — we never
 * coerce or repair.
 */
function validateWorkOrderPayload(wo: Record<string, unknown>): string | null {
  if (!isNonEmptyString(wo.id)) return 'missing wo.id';
  if (!isNonEmptyString(wo.title)) return 'missing/malformed wo.title';
  if (!isNonEmptyString(wo.status)) return 'missing/malformed wo.status';
  if (!isNonEmptyString(wo.rewardAmount)) return 'missing/malformed wo.rewardAmount';
  if (!isNonEmptyString(wo.creatorAddress)) return 'missing/malformed wo.creatorAddress';
  if (
    !Array.isArray(wo.requiredCapabilities) ||
    wo.requiredCapabilities.some((c) => typeof c !== 'string')
  ) {
    return 'missing/malformed wo.requiredCapabilities';
  }
  // `type` is optional downstream (WorkOrder.type?), but if the coordinator
  // sends it, it MUST be a string — a non-string would be cast blindly and
  // mis-route execution.
  if (wo.type !== undefined && typeof wo.type !== 'string') {
    return 'malformed wo.type';
  }
  return null;
}

function parseEnvelope(msg: Uint8Array): ParsedEnvelope | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(msg));
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  if (!('wo' in raw) || !('ts' in raw) || !('sig' in raw)) return null;
  return { wo: raw.wo, ts: raw.ts, sig: raw.sig };
}

export async function handleWorkOrderAvailable(args: HandleWOArgs): Promise<void> {
  const warn = args.warn ?? ((m: string) => logger.warn(m));
  const now = args.now ?? Date.now;
  const freshnessWindowSec = args.freshnessWindowSec ?? 60;

  // 1. Parse + shape check ------------------------------------------------
  const envelope = parseEnvelope(args.msg);
  if (!envelope) {
    warn('[WO-Verify] invalid envelope shape');
    return;
  }

  const { wo, ts, sig } = envelope;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    warn('[WO-Verify] invalid envelope shape (ts)');
    return;
  }
  if (typeof sig !== 'string' || sig.length === 0) {
    warn('[WO-Verify] invalid envelope shape (sig)');
    return;
  }
  if (!isObject(wo)) {
    warn('[WO-Verify] invalid envelope shape (wo)');
    return;
  }

  // 2. Verify signature + freshness + replay via the shared helper -------
  // `verifyCoordinatorEnvelope` reconstructs the coordinator's signed bytes
  // `JSON.stringify({ domain, body, ts })` (domain = DOMAIN_WO_AVAILABLE,
  // body = wo) — the SINGLE source of truth shared by all three topic
  // handlers. The domain tag is supplied here (never read from the wire), so
  // a signature minted for another topic cannot be replayed against this one.
  const result = verifyCoordinatorEnvelope({
    domain: DOMAIN_WO_AVAILABLE,
    body: wo,
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
      warn(`[WO-Verify] stale envelope (age=${ageSec}s > ${freshnessWindowSec}s)`);
      return;
    }
    if (result.reason === 'replayed') {
      warn(`[WO-Verify] replayed envelope dropped (sigPrefix=${sig.slice(0, 8)})`);
      return;
    }
    // bad-signature-encoding | invalid-signature → the existing throttled
    // invalid-sig warn + crisis stats path.
    emitInvalidSigWarn(warn, sig);
    return;
  }

  // Verify success — feed the rolling window so the crisis detector sees both
  // sides (without this it would over-report failures when only a brief
  // mismatch occurs amid healthy traffic).
  {
    const sigPrefix = sig.length > 0 ? sig.slice(0, 8) : 'no-sig';
    recordVerify(COORD_TOPIC, sigPrefix, true);
  }

  // 4. Post-verify payload shape -----------------------------------------
  // The signature only proves provenance, not that the payload carries the
  // fields execution needs. Validate the REQUIRED execution fields and
  // DROP+warn on the first missing/malformed one — a half-specified WO must
  // never reach the push queue (it would break capability matching / reward
  // math downstream). Reject-and-log; never repair.
  const reason = validateWorkOrderPayload(wo);
  if (reason !== null) {
    const woId = isNonEmptyString((wo as { id?: unknown }).id)
      ? (wo as { id: string }).id
      : '<unknown>';
    warn(`[WO-Verify] dropping work order ${sanitize(woId)}: ${reason}`);
    return;
  }

  // 5. Hand off to consumer ----------------------------------------------
  try {
    await args.consumer(wo as WorkOrderEnvelopePayload);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    warn(`[WO-Verify] consumer threw: ${sanitize(m)}`);
  }
}
