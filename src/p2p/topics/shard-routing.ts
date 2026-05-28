/**
 * shard-routing.ts — D-P2P Slice 2 (2026-05-28). NODE side.
 *
 * Shared shard-routing math for the TARGETED work-order push channel
 * (`WORK_ORDER_ASSIGNED`). On boot the node computes its own shard
 * `shardOf(myPeerId, K)` and subscribes ONLY to
 * `WORK_ORDER_ASSIGNED/shard/<myShard>`. The coordinator publishes a
 * targeted envelope to `shardOf(targetPeerId, K)` — the same topic the
 * target node subscribed to. With `K=1` (default) every peer maps to
 * shard 0 → a single topic, identical to a non-sharded broadcast.
 *
 * CRITICAL CONTRACT: this MUST be byte-identical to the coordinator side
 * (`packages/coordinator/src/infrastructure/p2p/shard-routing.ts`). If
 * the two diverge the coord publishes to a shard the node never joined
 * and delivery silently breaks. A consistency test on BOTH packages
 * (`__tests__/shard-routing.spec.ts`) asserts the SAME known
 * `peerId → shard` values for K=1 and K=4. DO NOT change the hash here
 * without changing it on the coord in the same commit.
 *
 * Hash = FNV-1a (32-bit) over the UTF-8 bytes of the peerId string.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32-bit hash of a UTF-8 string, returned as an unsigned int32. */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code < 0x80) {
      hash = mix(hash, code);
    } else if (code < 0x800) {
      hash = mix(hash, 0xc0 | (code >> 6));
      hash = mix(hash, 0x80 | (code & 0x3f));
    } else {
      hash = mix(hash, 0xe0 | (code >> 12));
      hash = mix(hash, 0x80 | ((code >> 6) & 0x3f));
      hash = mix(hash, 0x80 | (code & 0x3f));
    }
  }
  return hash >>> 0;
}

function mix(hash: number, byte: number): number {
  const h = (hash ^ byte) >>> 0;
  return Math.imul(h, FNV_PRIME) >>> 0;
}

/**
 * Read the shared shard count `K` from the environment. Both coord and
 * node read the SAME env var (`DPUSH_SHARD_COUNT`, default 1). An invalid
 * or non-positive value falls back to 1 (single topic) — fail-safe.
 */
export function resolveShardCount(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.DPUSH_SHARD_COUNT;
  if (raw === undefined || raw.trim() === '') return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 1;
  return parsed;
}

/** Deterministic shard index for a peerId given a shard count K. */
export function shardOf(peerId: string, shardCount: number): number {
  const k = Number.isInteger(shardCount) && shardCount >= 1 ? shardCount : 1;
  return fnv1a32(peerId) % k;
}

/** Base topic for targeted work-order assignment envelopes. */
export const WORK_ORDER_ASSIGNED_BASE = '/synapseia/work-order-assigned/1.0.0';

/** Full shard-routed topic name: `<base>/shard/<k>`. */
export function shardTopicForPeer(peerId: string, shardCount: number): string {
  return `${WORK_ORDER_ASSIGNED_BASE}/shard/${shardOf(peerId, shardCount)}`;
}
