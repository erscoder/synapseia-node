/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * kg-shard-snapshot-server.ts — Workstream F2 inbound server handler for
 * `KG_SHARD_SNAPSHOT_PROTOCOL`. Closes audit
 * `nodeLOW-kg-shard-snapshot-handler-unregistered` (the KNOWN-GAP docstring in
 * `kg-shard-snapshot.ts`).
 *
 * This is a NEW inbound auth surface. Every field on the request is hostile.
 * We fail-closed at each step and NEVER serve a single shard byte until the
 * full verify chain (steps 1-7) has passed. The chain binds the libp2p
 * connection → app identity → coord-verified membership using the coord
 * Ed25519 trust anchor that the node already hardcodes:
 *
 *   1. shape-check the request                          -> BAD_REQUEST
 *   2. verifyCoordinatorEnvelope on the attestation     -> NOT_AUTHORIZED
 *   3. attestation.body.p2pPeerId === conn.remotePeer   -> NOT_AUTHORIZED
 *   4. attestation.body.verified === true               -> NOT_AUTHORIZED
 *   5. Ed25519 verify req-sig under attestation.appPubkey -> NOT_AUTHORIZED
 *   6. freshness (±5min) + bounded replay on the hex sig  -> BAD_REQUEST / NOT_AUTHORIZED
 *   7. authorize: any verified node may pull any shard (single-node default)
 *   8. serve the shard via the existing stream-codec framing
 *
 * Crypto is REUSED, never hand-rolled (P10): the UNMODIFIED
 * `verifyCoordinatorEnvelope` (attestation) + the existing Ed25519 verifier
 * (`IdentityHelper.verifySignature`, request sig). Disk-only via
 * `IKgShardStorage` — zero DB/TypeORM/pg (memory `feedback_node_no_db`).
 * Project logger only, never `console.*` (memory `feedback_logger`). Required
 * deps are NOT `@Optional` — a loud throw on construction-time misconfig
 * (memory `feedback_di_wiring`), mirroring the client's constructor guards.
 *
 * Error frames use the existing `SnapshotError` union with a GENERIC `detail`
 * — never leak internal paths / pubkeys / stack traces (P17).
 */

import logger from '../../utils/logger';
import {
  endJsonStream,
  readJsonFromStream,
  sendJsonFrame,
} from '../../modules/p2p/stream-codec';
import { verifySignature } from '../../modules/identity/identity';
import {
  DOMAIN_PEER_IDENTITY_ATTESTATION,
  verifyCoordinatorEnvelope,
} from '../topics/verify-coordinator-envelope';
import type { ReplayGuard } from '../topics/replay-guard';
import type { IKgShardStorage, SnapshotRecord } from '../kg-shard/KgShardStorage';
import {
  KG_SHARD_SNAPSHOT_PROTOCOL,
  type SnapshotDone,
  type SnapshotError,
  type SnapshotRequest,
} from './kg-shard-snapshot';

export { KG_SHARD_SNAPSHOT_PROTOCOL };

/** Coord-signed attestation freshness window (24h) — §2 LOCKED SPEC. */
const ATTESTATION_FRESHNESS_SEC = 86_400;
/** Per-request app-sig freshness tolerance (±5 min) — matches the coord's
 *  `NodeSignatureGuard` 5-minute window. The TIGHT freshness lives here; the
 *  attestation `ts` window is deliberately loose (it is a re-issued
 *  credential). */
const REQ_FRESHNESS_MS = 5 * 60_000;
/** Raw Ed25519 sig / pubkey byte lengths — validated before any verify call
 *  (P10: never feed a wrong-length buffer to the verifier). */
const ED25519_SIG_BYTES = 64;
const ED25519_PUBKEY_BYTES = 32;

export interface KgShardSnapshotServerDeps {
  /** Disk-only shard store (no DB). */
  storage: IKgShardStorage;
  /** Trusted coord Ed25519 pubkey (raw 32 bytes) — the trust anchor. */
  coordinatorPubkey: Uint8Array;
  /**
   * Bounded replay guard keyed on the hex request signature. The guard TTL
   * MUST equal the request freshness window (5 min) so a signature is
   * remembered exactly as long as it could still pass the freshness check.
   * One guard instance per handler (wired at the registration site).
   */
  replayGuard: ReplayGuard;
}

/** Inbound libp2p handler signature — `(stream, connection)` positional,
 *  matching `P2PNode.handleProtocol`. */
export type SnapshotServerHandler = (
  stream: any,
  connection: any,
) => Promise<void>;

/** True iff `value` is a finite, non-NaN number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Lowercase-hex string guard (signature / pubkey fields). */
function isHex(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && /^[0-9a-f]+$/i.test(value);
}

/**
 * Shape-check a parsed inbound frame as a `SnapshotRequest`. Returns the
 * narrowed request or `null` (caller answers `BAD_REQUEST`). Treats every
 * field as hostile — wrong type / missing field / NaN all fail closed.
 */
function shapeCheck(raw: unknown): SnapshotRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (!isFiniteNumber(r.shardId) || !Number.isInteger(r.shardId) || r.shardId < 0) {
    return null;
  }
  if (!isHex(r.signature)) return null;
  if (!isFiniteNumber(r.publishedAtMs)) return null;

  const att = r.attestation;
  if (typeof att !== 'object' || att === null) return null;
  const a = att as Record<string, unknown>;
  if (!isFiniteNumber(a.ts)) return null;
  if (typeof a.sig !== 'string' || a.sig.length === 0) return null;

  const body = a.body;
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.p2pPeerId !== 'string' || b.p2pPeerId.length === 0) return null;
  if (!isHex(b.appPubkey)) return null;
  if (typeof b.verified !== 'boolean') return null;

  return {
    shardId: r.shardId,
    signature: r.signature,
    publishedAtMs: r.publishedAtMs,
    attestation: {
      body: {
        p2pPeerId: b.p2pPeerId,
        appPubkey: b.appPubkey,
        verified: b.verified,
      },
      ts: a.ts,
      sig: a.sig,
    },
  };
}

/**
 * Send a single `SnapshotError` frame then close the writable half cleanly.
 * `detail` is GENERIC (P17) — never an internal path / pubkey / stack trace.
 */
async function reject(
  stream: any,
  error: SnapshotError['error'],
  detail: string,
): Promise<void> {
  try {
    await sendJsonFrame(stream, { error, detail } satisfies SnapshotError);
  } catch {
    /* peer may have hung up — nothing else to do */
  }
  try {
    await endJsonStream(stream);
  } catch {
    /* ignore */
  }
}

/**
 * Build the inbound `KG_SHARD_SNAPSHOT_PROTOCOL` handler. Construction throws
 * loudly on any missing dependency (no `@Optional` — a misconfigured handler
 * is a deploy bug, not a runtime fall-through).
 */
export function makeKgShardSnapshotServerHandler(
  deps: KgShardSnapshotServerDeps,
): SnapshotServerHandler {
  if (!deps?.storage) {
    throw new Error('KgShardSnapshotServer: storage is required');
  }
  if (!deps.coordinatorPubkey || deps.coordinatorPubkey.length !== ED25519_PUBKEY_BYTES) {
    throw new Error(
      'KgShardSnapshotServer: coordinatorPubkey (raw 32-byte Ed25519) is required',
    );
  }
  if (!deps.replayGuard) {
    throw new Error('KgShardSnapshotServer: replayGuard is required');
  }
  const { storage, coordinatorPubkey, replayGuard } = deps;

  return async function handle(stream: any, connection: any): Promise<void> {
    const remotePeerId: string =
      connection?.remotePeer?.toString?.() ?? '<unknown>';
    try {
      // ── Step 1: read + shape-check ──────────────────────────────────────
      let parsed: unknown;
      try {
        parsed = await readJsonFromStream<unknown>(stream);
      } catch {
        await reject(stream, 'BAD_REQUEST', 'malformed request');
        return;
      }
      const req = shapeCheck(parsed);
      if (!req) {
        await reject(stream, 'BAD_REQUEST', 'malformed request');
        return;
      }

      const now = Date.now();

      // ── Step 2: verify coord-sig on the attestation ─────────────────────
      // The UNMODIFIED shared verifier. NOTE: the replay guard here is keyed
      // on the REQUEST sig (step 6), so we do NOT pass it to the envelope
      // verifier — the attestation `ts` is a re-issued credential and is fine
      // to re-present; tight anti-replay belongs to the per-request sig.
      const envelope = verifyCoordinatorEnvelope({
        domain: DOMAIN_PEER_IDENTITY_ATTESTATION,
        body: req.attestation.body,
        ts: req.attestation.ts,
        sigBase64: req.attestation.sig,
        coordinatorPubkey,
        now,
        freshnessWindowSec: ATTESTATION_FRESHNESS_SEC,
      });
      if (!envelope.ok) {
        await reject(stream, 'NOT_AUTHORIZED', 'not authorized');
        return;
      }

      // ── Step 3: bind connection ↔ attested identity ─────────────────────
      // Stops a stolen attestation replayed on a DIFFERENT connection.
      if (req.attestation.body.p2pPeerId !== remotePeerId) {
        await reject(stream, 'NOT_AUTHORIZED', 'not authorized');
        return;
      }

      // ── Step 4: membership bit ──────────────────────────────────────────
      if (req.attestation.body.verified !== true) {
        await reject(stream, 'NOT_AUTHORIZED', 'not authorized');
        return;
      }

      // ── Step 5: app-identity proof of intent ────────────────────────────
      // Verify `req|<shardId>|<publishedAtMs>` against the ATTESTED appPubkey.
      // Validate raw byte lengths first (P10) — never hand a wrong-length
      // buffer to the verifier.
      const appPubkey = req.attestation.body.appPubkey;
      const sigLenOk =
        Buffer.from(req.signature, 'hex').length === ED25519_SIG_BYTES;
      const pubLenOk =
        Buffer.from(appPubkey, 'hex').length === ED25519_PUBKEY_BYTES;
      if (!sigLenOk || !pubLenOk) {
        await reject(stream, 'NOT_AUTHORIZED', 'not authorized');
        return;
      }
      const message = `req|${req.shardId}|${req.publishedAtMs}`;
      let reqSigValid = false;
      try {
        reqSigValid = await verifySignature(message, req.signature, appPubkey);
      } catch {
        reqSigValid = false;
      }
      if (!reqSigValid) {
        await reject(stream, 'NOT_AUTHORIZED', 'not authorized');
        return;
      }

      // ── Step 6: freshness + replay on the request ───────────────────────
      // Freshness BEFORE replay so a stale sig never records an entry. The
      // replay entry is recorded ONLY after the sig is proven valid + fresh
      // (mirrors verify-coordinator-envelope.ts replay discipline).
      if (Math.abs(now - req.publishedAtMs) > REQ_FRESHNESS_MS) {
        await reject(stream, 'BAD_REQUEST', 'request expired');
        return;
      }
      if (replayGuard.seenBefore(req.signature, now)) {
        await reject(stream, 'NOT_AUTHORIZED', 'not authorized');
        return;
      }

      // ── Step 7: authorize (single-node default) ─────────────────────────
      // Any node that passed 1-6 is coord-verified and may pull any shard. No
      // per-shard check on devnet (deferred — §6).

      // ── Step 8: serve ───────────────────────────────────────────────────
      let total = 0;
      try {
        // Stream each record as a frame, then a terminal `done`. Reading via
        // the storage callback keeps the whole file off the heap. A
        // not-yet-held shard simply streams zero records (storage.read
        // returns 0 when the .bin is absent) — a benign empty snapshot.
        total = await streamShard(stream, storage, req.shardId);
      } catch {
        // Disk read failure mid-serve. Generic detail (P17). The peer aborts
        // its partial sync (no `done` frame arrives).
        await reject(stream, 'INTERNAL', 'serve failed');
        logger.warn(
          `[kg-snapshot-server] serve failed shard=${req.shardId} ` +
            `peer=${remotePeerId.slice(0, 12)}`,
        );
        return;
      }

      const done: SnapshotDone = {
        done: true,
        total,
        servedAtMs: now,
      };
      await sendJsonFrame(stream, done);
      await endJsonStream(stream);
      logger.log(
        `[kg-snapshot-server] served shard=${req.shardId} records=${total} ` +
          `peer=${remotePeerId.slice(0, 12)}`,
      );
    } catch (err) {
      // Last-resort guard — never throw out of an inbound handler. Generic
      // detail (P17); the message stays in the local log only.
      try {
        await reject(stream, 'INTERNAL', 'internal error');
      } catch {
        /* ignore */
      }
      logger.warn(
        `[kg-snapshot-server] unhandled error peer=${remotePeerId.slice(0, 12)}: ` +
          `${(err as Error).message}`,
      );
    }
  };
}

/**
 * Stream every persisted record for `shardId` to the peer as individual
 * frames. Returns the count streamed. Frames are sent sequentially; the
 * storage `read` callback is async-unaware, so we collect-then-send in
 * bounded batches via an internal queue would add complexity — instead we
 * await each send inside a thin promise chain to preserve back-pressure.
 */
async function streamShard(
  stream: any,
  storage: IKgShardStorage,
  shardId: number,
): Promise<number> {
  let count = 0;
  // `read` invokes `onRecord` synchronously per frame; we serialise the async
  // sends through a single tail promise so frames leave in order and
  // back-pressure is honoured.
  let tail: Promise<void> = Promise.resolve();
  await storage.read(shardId, (record: SnapshotRecord) => {
    tail = tail.then(() => sendJsonFrame(stream, record));
    count++;
  });
  await tail;
  return count;
}
