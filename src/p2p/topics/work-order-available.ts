/**
 * work-order-available.ts — node-side handler for the signed
 * `WORK_ORDER_AVAILABLE` gossipsub envelope published by the
 * coordinator.
 *
 * Wire format (`packages/coordinator/.../CoordinatorPublisher.ts`):
 *   {
 *     wo:  { id, missionId?, payload? },
 *     ts:  unix-seconds,
 *     sig: base64(Ed25519(JSON.stringify({wo, ts})))
 *   }
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
import { verifyEd25519 } from '../protocols/verify-ed25519';

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

export interface IncomingWorkOrder {
  id: string;
  missionId?: string;
  payload?: unknown;
  // Allow extra fields the coordinator forwards (e.g. type, status, …)
  // without forcing the consumer to relax its own type.
  [key: string]: unknown;
}

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
}

interface ParsedEnvelope {
  wo: unknown;
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

  // 2. Verify signature against `JSON.stringify({wo, ts})` ----------------
  // The signed payload MUST be reconstructed with the same key order the
  // publisher used: `{ wo, ts }`. Coordinator publishes via
  // `JSON.stringify({ wo, ts })` (see CoordinatorPublisher.ts), so we
  // mirror that exactly.
  const signedBytes = new TextEncoder().encode(JSON.stringify({ wo, ts }));
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

  // Verify success — feed the rolling window so the crisis detector
  // sees both sides (without this it would over-report failures when
  // only a brief mismatch occurs amid healthy traffic).
  {
    const sigPrefix = typeof sig === 'string' && sig.length > 0
      ? sig.slice(0, 8)
      : 'no-sig';
    recordVerify(COORD_TOPIC, sigPrefix, true);
  }

  // 3. Freshness check ----------------------------------------------------
  const ageSec = Math.floor(now() / 1000) - ts;
  if (ageSec > freshnessWindowSec) {
    warn(`[WO-Verify] stale envelope (age=${ageSec}s > ${freshnessWindowSec}s)`);
    return;
  }

  // 4. Post-verify payload shape -----------------------------------------
  const id = (wo as { id?: unknown }).id;
  if (typeof id !== 'string' || id.length === 0) {
    warn('[WO-Verify] missing wo.id');
    return;
  }

  // 5. Hand off to consumer ----------------------------------------------
  try {
    await args.consumer(wo as IncomingWorkOrder);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    warn(`[WO-Verify] consumer threw: ${sanitize(m)}`);
  }
}
