/**
 * Plan D.4-distribution.3 — deterministic shard mapping for a given
 * `embeddingId`. Both coord (publisher / snapshot server) and node
 * (delta handler / snapshot client / HNSW searcher) MUST produce the
 * same `shardId` for the same input or the routing invariants break.
 *
 * House style is to duplicate this 6-line helper per package rather
 * than extract a shared package — see memory `feedback_node_no_db`
 * and the existing duplication of `kg-shard-envelope.ts`. The mirror
 * lives at `packages/coordinator/src/application/knowledge-graph/shard-hash.ts`
 * and MUST stay byte-identical.
 *
 * Algorithm: SHA-256 of the UTF-8 `embeddingId`, take the first 4
 * bytes as a big-endian uint32, modulo `shardCount`. Picked over FNV
 * because `crypto.createHash` is already imported across the codebase
 * and SHA-256 has zero ambiguity in cross-runtime implementations.
 */

import { createHash } from 'crypto';

/** Bumped 16 → 32 on 2026-05-03 BEFORE devnet soak. Mirror of
 *  coord-side rationale — see
 *  `packages/coordinator/src/application/knowledge-graph/shard-hash.ts`
 *  for the math (half RAM/shard, double slots, migration cheap
 *  at current 933-row corpus). */
export const KG_SHARD_COUNT_DEFAULT = 32;

export function shardIdFor(
  embeddingId: string,
  shardCount: number = KG_SHARD_COUNT_DEFAULT,
): number {
  const digest = createHash('sha256').update(embeddingId, 'utf8').digest();
  return digest.readUInt32BE(0) % shardCount;
}
