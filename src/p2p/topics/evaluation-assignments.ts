/**
 * evaluation-assignments.ts — node-side handler for the signed
 * `EVALUATION_ASSIGNMENTS` gossipsub envelope published by the
 * coordinator on every newly-INSERTed `Evaluation` row.
 *
 * Wire format (`packages/coordinator/.../CoordinatorPublisher.ts`):
 *   {
 *     payload: { nodeId },
 *     ts:      unix-seconds,
 *     sig:     base64(Ed25519(JSON.stringify({payload, ts})))
 *   }
 *
 * Plan: Tier-3 §3.C.1.
 */
import logger from '../../utils/logger';
import { verifyEd25519 } from '../protocols/verify-ed25519';

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

  const signedBytes = new TextEncoder().encode(JSON.stringify({ payload, ts }));
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(sig, 'base64');
  } catch {
    warn('[Eval-Verify] invalid signature');
    return;
  }
  if (signatureBytes.length !== 64) {
    warn('[Eval-Verify] invalid signature');
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
    warn('[Eval-Verify] invalid signature');
    return;
  }

  const ageSec = Math.floor(now() / 1000) - ts;
  if (ageSec > freshnessWindowSec) {
    warn(`[Eval-Verify] stale envelope (age=${ageSec}s > ${freshnessWindowSec}s)`);
    return;
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
