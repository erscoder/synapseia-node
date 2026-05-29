/**
 * Tests for `CommitRevealV2Helper` — the node's side of the Commit-Reveal V2
 * protocol. Reward-sensitive: the coordinator pays out against the merkle
 * root this helper commits and the proofs it later reveals.
 *
 * Strategy: drive the REAL helper (no mocked crypto) with an injected `fetch`
 * stub that captures the outgoing request bodies. We then independently
 * recompute the merkle commitment from the submission content and verify:
 *   - commit → reveal round-trips (revealed proofs re-hash to the committed root)
 *   - a tampered reveal (swapped chunk) is rejected by the same verification
 *   - the chunking / hashing binding matches the helper's CHUNK_SIZE spec
 *
 * No IdentityService is injected, so `signedFetch` takes the unsigned path
 * (plain JSON POST) — that keeps the test focused on the merkle commitment
 * crypto, which is what reward correctness depends on here.
 */
import { createHash } from 'crypto';

import { CommitRevealV2Helper } from '../commit-reveal-v2';
import { MerkleTree, type MerkleProof } from '../../crypto/merkle-tree';

const CHUNK_SIZE = 256; // mirrors the constant in commit-reveal-v2.ts

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const pair = (l: string, r: string): string => sha(l + r);

/** Independently chunk content the same way the production helper does. */
function chunk(content: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    chunks.push(content.substring(i, i + CHUNK_SIZE));
  }
  return chunks;
}

/** Re-hash a revealed proof upward to its root (coordinator-side verify). */
function rehash(proof: MerkleProof): string {
  let acc = proof.leaf;
  let idx = proof.index;
  for (const sib of proof.siblings) {
    acc = idx % 2 === 1 ? pair(sib, acc) : pair(acc, sib);
    idx = Math.floor(idx / 2);
  }
  return acc;
}

interface CapturedRequest {
  url: string;
  body: any;
}

/**
 * Install a fetch stub that records each call and always returns 200 OK.
 * Returns the capture array + a restore fn.
 */
function installFetchStub(): { calls: CapturedRequest[]; restore: () => void } {
  const calls: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return {
      ok: true,
      status: 200,
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe('CommitRevealV2Helper', () => {
  let helper: CommitRevealV2Helper;
  let stub: ReturnType<typeof installFetchStub>;

  const COORD = 'http://coord.local';
  const PEER = 'peer-abc';
  const ROUND = 'round-42';

  beforeEach(() => {
    helper = new CommitRevealV2Helper(); // no IdentityService → unsigned path
    stub = installFetchStub();
  });

  afterEach(() => {
    stub.restore();
  });

  it('commits a merkle root that matches an independently-built tree', async () => {
    const content = 'x'.repeat(700); // 3 chunks (256 + 256 + 188)
    await helper.handleCommitPhase(COORD, PEER, ROUND, content);

    expect(stub.calls).toHaveLength(1);
    const commit = stub.calls[0];
    expect(commit.url).toBe(`${COORD}/research-rounds/${ROUND}/v2/commit`);

    const chunks = chunk(content);
    const expectedRoot = MerkleTree.buildTree(chunks).getRoot();

    expect(commit.body.peerId).toBe(PEER);
    expect(commit.body.merkleRoot).toBe(expectedRoot);
    expect(commit.body.leafCount).toBe(chunks.length);
    expect(chunks.length).toBe(3); // chunking binding sanity
  });

  it('does NOT commit when the submission content is empty (fail-closed)', async () => {
    await helper.handleCommitPhase(COORD, PEER, ROUND, '');
    expect(stub.calls).toHaveLength(0);
  });

  it('commit → reveal round-trip: revealed proofs re-hash to the committed root', async () => {
    const content = 'abcdefghij'.repeat(120); // 1200 chars → 5 chunks
    await helper.handleCommitPhase(COORD, PEER, ROUND, content);
    const committedRoot: string = stub.calls[0].body.merkleRoot;

    // Coordinator challenges a subset of indices.
    const challenged = [0, 2, 4];
    await helper.handleChallengeResponse(COORD, PEER, ROUND, challenged);

    expect(stub.calls).toHaveLength(2);
    const prove = stub.calls[1];
    expect(prove.url).toBe(`${COORD}/research-rounds/${ROUND}/v2/prove`);
    expect(prove.body.peerId).toBe(PEER);

    const proofs: MerkleProof[] = prove.body.proofs;
    expect(proofs).toHaveLength(challenged.length);

    // Each revealed proof must cryptographically re-hash to the SAME root
    // that was committed — this is the property the coordinator pays against.
    const chunks = chunk(content);
    for (const p of proofs) {
      expect(rehash(p)).toBe(committedRoot);
      // proof.leaf is the hashed chunk at its index
      expect(p.leaf).toBe(sha(chunks[p.index]));
    }
  });

  it('rejects a tampered reveal: swapping a chunk breaks root agreement', async () => {
    const content = 'payload-'.repeat(60); // 480 chars → 2 chunks
    await helper.handleCommitPhase(COORD, PEER, ROUND, content);
    const committedRoot: string = stub.calls[0].body.merkleRoot;

    await helper.handleChallengeResponse(COORD, PEER, ROUND, [0, 1]);
    const proofs: MerkleProof[] = stub.calls[1].body.proofs;

    // Simulate a relay/MITM tampering with a revealed leaf: replace one
    // proof's leaf hash with a hash of different content. The same
    // coordinator-side re-hash must now FAIL to reach the committed root.
    const tampered: MerkleProof = { ...proofs[0], leaf: sha('forged-content') };
    expect(rehash(tampered)).not.toBe(committedRoot);

    // The untouched proof still verifies — proving the failure is specific
    // to the tampered leaf, not a broken verifier.
    expect(rehash(proofs[1])).toBe(committedRoot);
  });

  it('clamps out-of-range challenge indices (does not throw, omits them)', async () => {
    const content = 'short'; // 1 chunk → leafCount 1, valid index = 0 only
    await helper.handleCommitPhase(COORD, PEER, ROUND, content);

    // Index 5 is beyond the single leaf — helper must skip it, not crash.
    await helper.handleChallengeResponse(COORD, PEER, ROUND, [0, 5]);

    const proofs: MerkleProof[] = stub.calls[1].body.proofs;
    expect(proofs).toHaveLength(1);
    expect(proofs[0].index).toBe(0);
  });

  it('does not POST proofs when there is no active state for the round', async () => {
    // No prior handleCommitPhase → no state. Challenge must no-op.
    await helper.handleChallengeResponse(COORD, PEER, 'unknown-round', [0]);
    expect(stub.calls).toHaveLength(0);
  });

  it('clears round state after responding to a challenge (no double-reveal)', async () => {
    const content = 'data'.repeat(100);
    await helper.handleCommitPhase(COORD, PEER, ROUND, content);
    await helper.handleChallengeResponse(COORD, PEER, ROUND, [0]);
    expect(stub.calls).toHaveLength(2);

    // A second challenge for the same round finds no state → no extra POST.
    await helper.handleChallengeResponse(COORD, PEER, ROUND, [0]);
    expect(stub.calls).toHaveLength(2);
  });
});
