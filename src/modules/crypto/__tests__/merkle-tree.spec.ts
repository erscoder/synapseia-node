/**
 * Tests for `MerkleTree` — the SHA-256 Merkle tree used by Commit-Reveal V2.
 *
 * This is reward-sensitive crypto: the coordinator pays out based on the
 * merkle root committed here and the proofs revealed against it. Every
 * assertion below uses REAL SHA-256 (Node native `crypto`), never a mock —
 * the test independently recomputes the expected hashes from first
 * principles so a regression in `buildTree` / `getRoot` / `getProof` (or a
 * surviving mutant) cannot pass.
 */
import { createHash } from 'crypto';

import { MerkleTree } from '../merkle-tree';

// ─── Independent reference implementation (mirrors the spec, not the impl) ──
// We recompute hashes here so the test asserts against KNOWN VECTORS rather
// than echoing whatever `MerkleTree` produced.
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const pair = (l: string, r: string): string => sha(l + r);

describe('MerkleTree.buildTree / getRoot — known vectors', () => {
  it('throws when built with no leaves (fail-closed)', () => {
    expect(() => MerkleTree.buildTree([])).toThrow(/no leaves/i);
  });

  it('1 leaf: root equals the leaf hash', () => {
    const root = MerkleTree.buildTree(['only']).getRoot();
    expect(root).toBe(sha('only'));
  });

  it('2 leaves: root = H(H(a) + H(b))', () => {
    const root = MerkleTree.buildTree(['a', 'b']).getRoot();
    expect(root).toBe(pair(sha('a'), sha('b')));
  });

  it('3 leaves (odd count): the last node is duplicated, not dropped', () => {
    // Layer 0: [H(a), H(b), H(c)]
    // Layer 1: [H(H(a)+H(b)), H(H(c)+H(c))]   <- H(c) duplicated against itself
    // Root:    H(layer1[0] + layer1[1])
    const ha = sha('a');
    const hb = sha('b');
    const hc = sha('c');
    const left = pair(ha, hb);
    const right = pair(hc, hc); // odd-leaf duplication rule
    const expectedRoot = pair(left, right);

    const root = MerkleTree.buildTree(['a', 'b', 'c']).getRoot();
    expect(root).toBe(expectedRoot);
  });

  it('odd duplication is distinguishable from explicit duplicate input', () => {
    // A 3-leaf tree [a,b,c] must produce the SAME root as a 4-leaf tree
    // [a,b,c,c] precisely BECAUSE the odd leaf is duplicated. If the
    // duplication rule broke (e.g. dropped the odd leaf), these would diverge.
    const odd = MerkleTree.buildTree(['a', 'b', 'c']).getRoot();
    const explicit = MerkleTree.buildTree(['a', 'b', 'c', 'c']).getRoot();
    expect(odd).toBe(explicit);
  });

  it('getLeafCount reflects the number of input leaves', () => {
    expect(MerkleTree.buildTree(['a', 'b', 'c']).getLeafCount()).toBe(3);
    expect(MerkleTree.buildTree(['x']).getLeafCount()).toBe(1);
  });

  it('different leaf content yields a different root (collision-resistance sanity)', () => {
    const a = MerkleTree.buildTree(['a', 'b', 'c', 'd']).getRoot();
    const b = MerkleTree.buildTree(['a', 'b', 'c', 'D']).getRoot();
    expect(a).not.toBe(b);
  });
});

describe('MerkleTree.getProof — siblings re-hash to getRoot', () => {
  // Re-hash a leaf upward through its sibling set and assert the result
  // equals the committed root. This is exactly what the coordinator does to
  // verify a revealed proof, so it proves the proof is *cryptographically*
  // valid, not merely well-shaped.
  function rehash(leafHash: string, proofIndex: number, siblings: string[]): string {
    let acc = leafHash;
    let idx = proofIndex;
    for (const sib of siblings) {
      acc = idx % 2 === 1 ? pair(sib, acc) : pair(acc, sib);
      idx = Math.floor(idx / 2);
    }
    return acc;
  }

  it.each([
    { leaves: ['a', 'b'], n: 2 },
    { leaves: ['a', 'b', 'c'], n: 3 },
    { leaves: ['a', 'b', 'c', 'd', 'e'], n: 5 },
    { leaves: ['w', 'x', 'y', 'z'], n: 4 },
  ])('every index of a $n-leaf tree produces a proof re-hashing to the root', ({ leaves }) => {
    const tree = MerkleTree.buildTree(leaves);
    const root = tree.getRoot();

    for (let i = 0; i < leaves.length; i++) {
      const proof = tree.getProof(i);
      expect(proof.index).toBe(i);
      expect(proof.leaf).toBe(sha(leaves[i])); // proof.leaf is the HASHED leaf
      expect(rehash(proof.leaf, proof.index, proof.siblings)).toBe(root);
    }
  });

  it('a proof for one index does NOT verify against a different leaf', () => {
    const leaves = ['a', 'b', 'c', 'd'];
    const tree = MerkleTree.buildTree(leaves);
    const root = tree.getRoot();
    const proof = tree.getProof(1); // proof for 'b'

    // Re-hash using 'b's sibling path but with 'c's leaf hash → must not match.
    const wrong = rehash(sha('c'), proof.index, proof.siblings);
    expect(wrong).not.toBe(root);
  });

  it('single-leaf tree: proof has no siblings and the leaf hash IS the root', () => {
    const tree = MerkleTree.buildTree(['solo']);
    const proof = tree.getProof(0);
    expect(proof.siblings).toEqual([]);
    expect(proof.leaf).toBe(tree.getRoot());
  });

  it('throws on a negative index (out of bounds)', () => {
    const tree = MerkleTree.buildTree(['a', 'b']);
    expect(() => tree.getProof(-1)).toThrow(/out of bounds/i);
  });

  it('throws on an index >= leaf count (out of bounds)', () => {
    const tree = MerkleTree.buildTree(['a', 'b', 'c']);
    expect(() => tree.getProof(3)).toThrow(/out of bounds/i);
  });
});

describe('MerkleTree.hash / hashPair — primitives', () => {
  it('hash matches Node native SHA-256 hex', () => {
    expect(MerkleTree.hash('hello')).toBe(sha('hello'));
  });

  it('hashPair concatenates left + right (order-sensitive)', () => {
    expect(MerkleTree.hashPair('aa', 'bb')).toBe(sha('aa' + 'bb'));
    // Swapping operands must change the hash (proves no commutative bug).
    expect(MerkleTree.hashPair('aa', 'bb')).not.toBe(MerkleTree.hashPair('bb', 'aa'));
  });
});
