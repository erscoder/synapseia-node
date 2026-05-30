/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Plan D.4-distribution.4 — node-side dialer for the KG-shard
 * snapshot stream protocol shipped in D.4-distribution.2. Tries
 * peers (in `hints` order) first, then coord as last fallback. One
 * successful pull is enough — the result is a flat append-only file
 * at `<nodeHome>/shards/shard-<id>.bin`.
 *
 * Why peer-first: once one peer (A) has the shard, every subsequent
 * cold-boot peer (B, C, …) should pull from A so coord uplink stays
 * ≈ 0. The hint map is populated by the `KG_SHARD_SNAPSHOT_READY`
 * topic handler (D.4-distribution.5).
 *
 * Auth on the dialer side: sign `req|<shardId>|<publishedAtMs>` with
 * the node's Ed25519 *application identity* key (`identity.privateKey`).
 *
 * KNOWN GAP (audit nodeLOW-kg-shard-snapshot-handler-unregistered):
 * there is currently NO server-side handler registered for
 * KG_SHARD_SNAPSHOT_PROTOCOL on the node (node-runtime.ts registers
 * KG_SHARD_QUERY_PROTOCOL but not this one). As a result every
 * peer-first snapshot pull fails its peer candidates and falls through
 * to the coord fallback in `fetch()`. Implementing the server handler
 * is blocked on TWO unresolved design problems that this client-side
 * file cannot fix alone:
 *   1. Signature binding — the dialer signs with the app-layer Ed25519
 *      identity key, but a libp2p stream handler only sees
 *      `conn.remotePeer` (a libp2p peerId / pubkey from a DIFFERENT
 *      keypair). There is no trusted node-side mapping from the libp2p
 *      peerId to the app identity pubkey, so the request signature
 *      cannot be verified against the connecting peer as the original
 *      docstring implied.
 *   2. Authorization — there is no node-side store of which requesters
 *      are permitted to pull a shard (the ownership store only records
 *      which shards THIS node hosts).
 * Closing this requires a resolved auth model (signed coord redirect or
 * a libp2p↔app-identity binding) + a requester-authorization source, so
 * it is tracked as a dedicated follow-up rather than shipped half-built
 * (a handler that "verifies" the wrong key would be a fake control).
 *
 * Memory `feedback_node_no_db`: zero TypeORM/pg drivers. Disk only.
 * Memory `feedback_logger`: project logger; never `console.*`.
 * Memory `feedback_di_wiring`: required deps NOT @Optional; loud
 * throw on construction-time misconfiguration.
 */

import logger from '../../utils/logger';
import {
  endJsonStream,
  readJsonFramesUntilDone,
  sendJsonFrame,
} from '../../modules/p2p/stream-codec';
import { sign as ed25519Sign } from '../../modules/identity/identity';
import type { Identity } from '../../modules/identity/identity';
import type { IKgShardStorage, SnapshotRecord } from '../kg-shard/KgShardStorage';

export const KG_SHARD_SNAPSHOT_PROTOCOL = '/synapseia/kg-shard-snapshot/1.0.0';

const VECTOR_DIM = 768;

/**
 * Workstream F — coord-signed peer-identity attestation carried on the wire
 * inside a `SnapshotRequest`. Byte-identical shape to the heartbeat-cached
 * `{ body, ts, sig }` (see `heartbeat.ts :: IdentityAttestation` and
 * `audits/F-identity-binding-design.md` §2). The serving node verifies it via
 * the UNMODIFIED `verifyCoordinatorEnvelope` to bind this connection → app
 * identity → coord-verified membership.
 */
export interface SnapshotAttestation {
  body: { p2pPeerId: string; appPubkey: string; verified: boolean };
  /** Unix-SECONDS — coord-signed. */
  ts: number;
  /** Base64 Ed25519 signature. */
  sig: string;
}

export interface SnapshotRequest {
  shardId: number;
  signature: string;
  publishedAtMs: number;
  /**
   * Workstream F — coord-signed identity attestation (clean cut-over, NOT
   * optional on the wire). The dialer reads it from the heartbeat cache; if
   * none is cached the dialer throws BEFORE opening a stream (no
   * attestation-absent legacy path — coord+node ship lockstep).
   */
  attestation: SnapshotAttestation;
}

/**
 * Provider the dialer uses to read the latest cached coord-signed attestation
 * (implemented by `HeartbeatHelper.getIdentityAttestation`). Kept as a thin
 * interface so the spec can inject a canned attestation without a heartbeat.
 */
export interface IAttestationProvider {
  getIdentityAttestation(): SnapshotAttestation | null;
}

export interface SnapshotDone {
  done: true;
  total: number;
  servedAtMs: number;
}

export interface SnapshotError {
  error: 'NOT_AUTHORIZED' | 'BAD_REQUEST' | 'INTERNAL';
  detail?: string;
}

export interface SnapshotPeerHint {
  peerId: string;
  isCoord: boolean;
}

/** Adapter that opens a libp2p stream — abstracted so the spec can
 *  pass canned streams without spinning up a real libp2p instance. */
export interface ISnapshotDialer {
  dial(peerId: string, protocol: string): Promise<any>;
}

export interface IKgShardSnapshotClient {
  /** Try `hints` (peer-first), then coord as fallback. Returns total
   *  records persisted. Throws if every candidate fails. */
  fetch(
    shardId: number,
    hints: SnapshotPeerHint[],
    coordPeerId: string,
  ): Promise<number>;
}

export class KgShardSnapshotClient implements IKgShardSnapshotClient {
  constructor(
    private readonly dialer: ISnapshotDialer,
    private readonly identity: Identity,
    private readonly storage: IKgShardStorage,
    private readonly attestations: IAttestationProvider,
  ) {
    if (!dialer) throw new Error('KgShardSnapshotClient: dialer is required');
    if (!identity?.privateKey) {
      throw new Error('KgShardSnapshotClient: identity with privateKey is required');
    }
    if (!storage) throw new Error('KgShardSnapshotClient: storage is required');
    if (!attestations) {
      throw new Error('KgShardSnapshotClient: attestation provider is required');
    }
  }

  async fetch(
    shardId: number,
    hints: SnapshotPeerHint[],
    coordPeerId: string,
  ): Promise<number> {
    const candidates: SnapshotPeerHint[] = [
      ...hints.filter((h) => !h.isCoord && h.peerId !== coordPeerId),
      { peerId: coordPeerId, isCoord: true },
    ];
    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        const total = await this.fetchFromPeer(candidate.peerId, shardId);
        logger.log(
          `[kg-snapshot] shard=${shardId} source=${candidate.peerId.slice(0, 12)} records=${total}`,
        );
        return total;
      } catch (err) {
        errors.push(
          `${candidate.peerId.slice(0, 12)}(${candidate.isCoord ? 'coord' : 'peer'}): ${(err as Error).message}`,
        );
      }
    }
    throw new Error(
      `[kg-snapshot] all candidates failed for shard=${shardId}: ${errors.join('; ')}`,
    );
  }

  /** Public for the spec — opens a stream against `peerId`, sends the
   *  signed request, reads the framed snapshot into the storage tmp
   *  file, and atomically commits on `done`. */
  async fetchFromPeer(peerId: string, shardId: number): Promise<number> {
    // Workstream F — read the cached coord-signed attestation BEFORE dialing.
    // No attestation ⇒ we cannot prove coord-verified membership to a serving
    // peer, so fail fast (the caller falls through to the coord fallback)
    // rather than open a stream that is guaranteed to be rejected.
    const attestation = this.attestations.getIdentityAttestation();
    if (!attestation) {
      throw new Error(
        'KgShardSnapshotClient: no coord-signed identity attestation cached ' +
          '(heartbeat has not delivered one yet) — cannot pull from peers',
      );
    }
    const stream = await this.dialer.dial(peerId, KG_SHARD_SNAPSHOT_PROTOCOL);
    const publishedAtMs = Date.now();
    const sigBytes = await ed25519Sign(
      `req|${shardId}|${publishedAtMs}`,
      this.identity.privateKey,
    );
    const req: SnapshotRequest = {
      shardId,
      signature: sigBytes,
      publishedAtMs,
      attestation,
    };
    await sendJsonFrame(stream, req);

    const session = await this.storage.openSync(shardId);
    let dropped = 0;
    let appended = 0;
    let failed: SnapshotError | null = null;

    try {
      const done = await readJsonFramesUntilDone<
        SnapshotRecord | SnapshotError,
        SnapshotDone
      >(
        stream,
        async (frame) => {
          if ('error' in (frame as SnapshotError)) {
            failed = frame as SnapshotError;
            return;
          }
          const record = frame as SnapshotRecord;
          if (!Array.isArray(record.vector) || record.vector.length !== VECTOR_DIM) {
            dropped++;
            logger.warn(
              `[kg-snapshot] dropped record from peer=${peerId.slice(0, 12)} shard=${shardId} reason=bad_vector_dim`,
            );
            return;
          }
          await session.write(record);
          appended++;
        },
        (frame): frame is SnapshotDone => (frame as any).done === true,
      );

      if (failed) {
        await session.abort();
        throw new Error(
          `peer=${peerId.slice(0, 12)} returned ${(failed as SnapshotError).error}: ${(failed as SnapshotError).detail ?? ''}`,
        );
      }

      await session.commit(appended);
      if (dropped > 0) {
        logger.warn(
          `[kg-snapshot] shard=${shardId} appended=${appended} dropped=${dropped} (sent total=${done.total})`,
        );
      }
      await endJsonStream(stream);
      return appended;
    } catch (err) {
      try { await session.abort(); } catch { /* already aborted */ }
      try { await endJsonStream(stream); } catch { /* ignore */ }
      throw err;
    }
  }
}
