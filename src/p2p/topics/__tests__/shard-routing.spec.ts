/**
 * D-P2P Slice 2 (2026-05-28) — shard-routing consistency (NODE side).
 *
 * CROSS-SIDE CONTRACT: the SAME fixture block lives in the coord spec
 * (`packages/coordinator/src/infrastructure/p2p/__tests__/shard-routing.spec.ts`).
 * Both packages MUST produce the SAME `peerId → shard` for the SAME K, or
 * coord publishes to a shard the node never joined and delivery breaks.
 * If you change `SHARD_FIXTURES` here, change it identically there.
 */
import {
  fnv1a32,
  shardOf,
  resolveShardCount,
  shardTopicForPeer,
  WORK_ORDER_ASSIGNED_BASE,
} from '../shard-routing';

// peerId → { hash, shardK1, shardK4 } — golden vectors (see coord spec).
// These MUST be byte-identical to the coordinator-side fixtures.
const SHARD_FIXTURES: Record<string, { hash: number; k1: number; k4: number }> = {
  '12D3KooWAlpha': { hash: 1369596197, k1: 0, k4: 1 },
  '12D3KooWBeta': { hash: 2000446617, k1: 0, k4: 1 },
  '12D3KooWGamma': { hash: 2174523944, k1: 0, k4: 0 },
  'peer-T': { hash: 1287693864, k1: 0, k4: 0 },
  peerX: { hash: 3659970499, k1: 0, k4: 3 },
};

describe('shard-routing (node) — golden vectors', () => {
  for (const [peerId, fx] of Object.entries(SHARD_FIXTURES)) {
    it(`${peerId}: hash + shard for K=1 and K=4`, () => {
      expect(fnv1a32(peerId)).toBe(fx.hash);
      expect(shardOf(peerId, 1)).toBe(fx.k1);
      expect(shardOf(peerId, 4)).toBe(fx.k4);
    });
  }

  it('K=1 maps every peer to shard 0 (single-topic default)', () => {
    for (const peerId of Object.keys(SHARD_FIXTURES)) {
      expect(shardOf(peerId, 1)).toBe(0);
    }
  });

  it('shardTopicForPeer builds <base>/shard/<k> (must match coord)', () => {
    expect(shardTopicForPeer('peerX', 4)).toBe(`${WORK_ORDER_ASSIGNED_BASE}/shard/3`);
    expect(shardTopicForPeer('peer-T', 1)).toBe(`${WORK_ORDER_ASSIGNED_BASE}/shard/0`);
  });

  it('resolveShardCount defaults to 1 and is fail-safe', () => {
    expect(resolveShardCount({} as NodeJS.ProcessEnv)).toBe(1);
    expect(resolveShardCount({ DPUSH_SHARD_COUNT: '' } as NodeJS.ProcessEnv)).toBe(1);
    expect(resolveShardCount({ DPUSH_SHARD_COUNT: '0' } as NodeJS.ProcessEnv)).toBe(1);
    expect(resolveShardCount({ DPUSH_SHARD_COUNT: 'abc' } as NodeJS.ProcessEnv)).toBe(1);
    expect(resolveShardCount({ DPUSH_SHARD_COUNT: '4' } as NodeJS.ProcessEnv)).toBe(4);
  });
});
