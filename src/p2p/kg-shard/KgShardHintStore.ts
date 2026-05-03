/**
 * Plan D.4-distribution.5 — in-memory `Map<shardId, Set<peerId>>`
 * populated by the `KG_SHARD_SNAPSHOT_READY` topic handler. The
 * snapshot client (D.4-distribution.4) consults it to pick a peer
 * to dial BEFORE falling through to coord — chained sync.
 *
 * Lives in memory only; no persistence. On node restart the hint
 * map starts empty and rebuilds as peers re-announce on next ready
 * tick. That's acceptable: at worst the first cold-boot peer dials
 * coord once, the next inherits the announcement and chains.
 *
 * Memory `feedback_node_no_db` — no disk / DB.
 */

export interface IKgShardHintStore {
  add(shardId: number, peerId: string): void;
  /** Remove a peerId from EVERY shard hint set (used on peer
   *  disconnect; not wired in v1 but the API is here for the future). */
  forget(peerId: string): void;
  /** Snapshot of currently-known hosters for `shardId`. The order is
   *  insertion order — newest peer last — so the snapshot client can
   *  iterate freshest-first by reversing. */
  hintsFor(shardId: number): string[];
}

export class KgShardHintStore implements IKgShardHintStore {
  private readonly store = new Map<number, Set<string>>();

  add(shardId: number, peerId: string): void {
    let set = this.store.get(shardId);
    if (!set) {
      set = new Set();
      this.store.set(shardId, set);
    }
    set.add(peerId);
  }

  forget(peerId: string): void {
    for (const set of this.store.values()) {
      set.delete(peerId);
    }
  }

  hintsFor(shardId: number): string[] {
    const set = this.store.get(shardId);
    if (!set) return [];
    return Array.from(set);
  }
}
