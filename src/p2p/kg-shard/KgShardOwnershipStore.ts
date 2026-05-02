/**
 * KgShardOwnershipStore — in-memory record of the shards this node is
 * authorised to host.
 *
 * Coord publishes signed `KG_SHARD_OWNERSHIP` envelopes every 10 min
 * (and on revocation) — the gossipsub handler updates this store after
 * verifying the signature. The libp2p stream handler for
 * `/synapseia/kg-shard-query/1.0.0` checks `has(shardId)` before
 * answering. No persistence: a restart drops the set and the next coord
 * tick (≤10 min) refills it. That window is acceptable because the
 * coord's race fallback (Plan D.5) services queries from Postgres while
 * a node is reboarding.
 *
 * Plan D.4.
 */
export interface IKgShardOwnershipStore {
  /** Insert / update the grant. `expiresAt` is unix-ms. */
  set(shardId: number, expiresAt: number): void;
  /** Remove the grant immediately (revocation or post-expiry). */
  delete(shardId: number): void;
  /** Returns true iff the node is currently authorised for this shard.
   *  Side-effect: prunes any expired grants encountered along the way. */
  has(shardId: number): boolean;
  /** Returns the unix-ms expiry for `shardId`, or undefined when no
   *  grant exists / it has expired. */
  expiresAt(shardId: number): number | undefined;
  /** Snapshot of currently-active shard ids — used by tests + the
   *  optional `/healthz` reporter. */
  list(): number[];
}

export class KgShardOwnershipStore implements IKgShardOwnershipStore {
  private readonly grants = new Map<number, number>();

  constructor(private readonly now: () => number = Date.now) {}

  set(shardId: number, expiresAt: number): void {
    if (!Number.isFinite(shardId) || shardId < 0) return;
    if (!Number.isFinite(expiresAt)) return;
    if (expiresAt <= this.now()) {
      // already expired — treat as a delete so revoke + expiry are
      // observably the same path
      this.grants.delete(shardId);
      return;
    }
    this.grants.set(shardId, expiresAt);
  }

  delete(shardId: number): void {
    this.grants.delete(shardId);
  }

  has(shardId: number): boolean {
    const exp = this.grants.get(shardId);
    if (exp === undefined) return false;
    if (exp <= this.now()) {
      this.grants.delete(shardId);
      return false;
    }
    return true;
  }

  expiresAt(shardId: number): number | undefined {
    if (!this.has(shardId)) return undefined;
    return this.grants.get(shardId);
  }

  list(): number[] {
    const now = this.now();
    const out: number[] = [];
    for (const [shardId, exp] of this.grants.entries()) {
      if (exp <= now) {
        this.grants.delete(shardId);
        continue;
      }
      out.push(shardId);
    }
    return out.sort((a, b) => a - b);
  }
}
