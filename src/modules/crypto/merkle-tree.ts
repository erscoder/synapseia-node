/**
 * SHA-256 Merkle Tree — copied from packages/coordinator/src/domain/crypto/MerkleTree.ts.
 * Node-side: only buildTree() + getRoot() + getProof() are used. The coordinator
 * handles verify() + consensus on its side.
 *
 * Kept as a literal copy (not a shared package) to avoid a workspace dependency
 * that would complicate the node's standalone build (tsup bundles everything).
 */

import { createHash } from 'crypto';

export interface MerkleProof {
  leaf: string;
  siblings: string[];
  index: number;
}

export class MerkleTree {
  private readonly layers: string[][];

  private constructor(layers: string[][]) {
    this.layers = layers;
  }

  static buildTree(leaves: string[]): MerkleTree {
    if (leaves.length === 0) {
      throw new Error('Cannot build Merkle tree with no leaves');
    }
    const hashedLeaves = leaves.map((leaf) => MerkleTree.hash(leaf));
    const layers: string[][] = [hashedLeaves];
    let currentLayer = hashedLeaves;
    while (currentLayer.length > 1) {
      const nextLayer: string[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        const right = i + 1 < currentLayer.length ? currentLayer[i + 1] : currentLayer[i];
        nextLayer.push(MerkleTree.hashPair(left, right));
      }
      layers.push(nextLayer);
      currentLayer = nextLayer;
    }
    return new MerkleTree(layers);
  }

  getRoot(): string {
    return this.layers[this.layers.length - 1][0];
  }

  getLeafCount(): number {
    return this.layers[0].length;
  }

  getProof(index: number): MerkleProof {
    if (index < 0 || index >= this.layers[0].length) {
      throw new Error(`Index ${index} out of bounds (0..${this.layers[0].length - 1})`);
    }
    const siblings: string[] = [];
    let currentIndex = index;
    for (let level = 0; level < this.layers.length - 1; level++) {
      const layer = this.layers[level];
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      const sibling = siblingIndex < layer.length ? layer[siblingIndex] : layer[currentIndex];
      siblings.push(sibling);
      currentIndex = Math.floor(currentIndex / 2);
    }
    return { leaf: this.layers[0][index], siblings, index };
  }

  static hash(data: string): string {
    return createHash('sha256').update(data).digest('hex');
  }

  static hashPair(left: string, right: string): string {
    return createHash('sha256').update(left + right).digest('hex');
  }
}
