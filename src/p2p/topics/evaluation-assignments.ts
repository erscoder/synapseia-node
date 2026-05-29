/**
 * evaluation-assignments.ts — node-side handler for the signed
 * `EVALUATION_ASSIGNMENTS` gossipsub envelope published by the
 * coordinator on every newly-INSERTed `Evaluation` row.
 *
 * Wire format (`packages/coordinator/.../CoordinatorPublisher.ts`):
 *   {
 *     payload: { nodeId },
 *     ts:      unix-seconds,
 *     sig:     base64(Ed25519(signed-bytes))
 *   }
 *
 * The signed bytes are `JSON.stringify({ domain:
 * 'synapseia/gossip/evaluation-assignments/v1', body: payload, ts })`
 * (coordinator `signedEnvelopeBytes` helper), reconstructed by the shared
 * `verifyCoordinatorEnvelope`. The domain tag is never on the wire and
 * differs from the WORK_ORDER_ASSIGNED tag, so a signature minted for one
 * cannot be replayed against the other (cross-type replay fix).
 *
 * Plan: Tier-3 §3.C.1.
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
  DOMAIN_EVAL_ASSIGNMENTS,
  verifyCoordinatorEnvelope,
} from './verify-coordinator-envelope';

const COORD_TOPIC = 'EVALUATION_ASSIGNMENTS';

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
      `[Eval-Verify] invalid signature ` +
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

export interface EvaluationAssignmentsKick {
  nodeId: string;
}

export interface HandleEvalArgs {
  pubkey: Uint8Array;
  msg: Uint8Array;
  consumer: (kick: EvaluationAssignmentsKick) => Promise<void> | void;
  warn?: (msg: string) => void;
  now?: () => number;
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

export async function handleEvaluationAssignments(args: HandleEvalArgs): Promise<void> {
  const warn = args.warn ?? ((m: string) => logger.warn(m));
  const now = args.now ?? Date.now;
  const freshnessWindowSec = args.freshnessWindowSec ?? 60;

  const envelope = parseEnvelope(args.msg);
  if (!envelope) {
    warn('[Eval-Verify] invalid envelope shape');
    return;
  }

  const { payload, ts, sig } = envelope;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    warn('[Eval-Verify] invalid envelope shape (ts)');
    return;
  }
  if (typeof sig !== 'string' || sig.length === 0) {
    warn('[Eval-Verify] invalid envelope shape (sig)');
    return;
  }
  if (!isObject(payload)) {
    warn('[Eval-Verify] invalid envelope shape (payload)');
    return;
  }

  // Verify signature + freshness + replay via the shared helper. The signed
  // bytes are `JSON.stringify({ domain: DOMAIN_EVAL_ASSIGNMENTS, body:
  // payload, ts })`; the domain tag (supplied here, never read from the wire)
  // makes this signature DISTINCT from a WORK_ORDER_ASSIGNED one despite the
  // identical `{ payload, ts }` wire shape — cross-type replay fix.
  const result = verifyCoordinatorEnvelope({
    domain: DOMAIN_EVAL_ASSIGNMENTS,
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
      warn(`[Eval-Verify] stale envelope (age=${ageSec}s > ${freshnessWindowSec}s)`);
      return;
    }
    if (result.reason === 'replayed') {
      warn(`[Eval-Verify] replayed envelope dropped (sigPrefix=${sig.slice(0, 8)})`);
      return;
    }
    emitInvalidSigWarn(warn, sig);
    return;
  }

  // Verify success — feed the rolling window (see WO handler for rationale).
  {
    const sigPrefix = sig.length > 0 ? sig.slice(0, 8) : 'no-sig';
    recordVerify(COORD_TOPIC, sigPrefix, true);
  }

  const nodeId = (payload as { nodeId?: unknown }).nodeId;
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    warn('[Eval-Verify] missing payload.nodeId');
    return;
  }

  try {
    await args.consumer({ nodeId });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    warn(`[Eval-Verify] consumer threw: ${sanitize(m)}`);
  }
}
