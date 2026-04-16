/**
 * CommitRevealV2Helper — handles the node's participation in the
 * Commit-Reveal V2 protocol (Merkle roots, challenge proofs).
 *
 * Lifecycle:
 *   1. RoundListener receives `round.v2.started` → helper is notified
 *   2. Helper looks up the node's latest submission for that round
 *   3. Builds a Merkle tree from the submission content (chunked)
 *   4. POSTs the Merkle root to /research-rounds/:roundId/v2/commit
 *   5. Listens for `round.v2.challenge_issued` → generates proofs
 *   6. POSTs proofs to /research-rounds/:roundId/v2/prove
 *   7. Done — coordinator verifies and advances the round
 */

import { Injectable, Optional } from '@nestjs/common';
import logger from '../../utils/logger';
import { MerkleTree, type MerkleProof } from '../crypto/merkle-tree';
import { IdentityService } from '../identity/services/identity.service';
import { buildAuthHeaders } from '../../utils/node-auth';

const CHUNK_SIZE = 256;

interface V2RoundState {
  roundId: string;
  tree: MerkleTree;
  chunks: string[];
}

@Injectable()
export class CommitRevealV2Helper {
  /** In-flight V2 rounds this node is participating in. Keyed by roundId. */
  private readonly activeRounds = new Map<string, V2RoundState>();

  private _keypair?: Uint8Array;
  private _publicKey?: Uint8Array;
  private _peerId?: string;

  constructor(@Optional() private readonly identityService?: IdentityService) {}

  async onModuleInit(): Promise<void> {
    if (this.identityService) {
      try {
        const identity = this.identityService.getOrCreate();
        if (identity?.privateKey && identity?.publicKey) {
          this._keypair = Buffer.from(identity.privateKey, 'hex');
          this._publicKey = Buffer.from(identity.publicKey, 'hex');
          this._peerId = identity.peerId;
        }
      } catch {
        // Non-fatal — identity might not be set up yet
      }
    }
  }

  // ─── Event handlers (called by RoundListener) ────────────────────────

  /**
   * Called when the coordinator broadcasts `round.v2.started` or
   * `round.v2.commit_open`. Builds the Merkle tree and submits the root.
   */
  async handleCommitPhase(
    coordinatorUrl: string,
    peerId: string,
    roundId: string,
    submissionContent: string,
  ): Promise<void> {
    if (!submissionContent || submissionContent.length === 0) {
      logger.warn(`[CommitRevealV2] Round ${roundId}: no submission content to commit`);
      return;
    }

    // Chunk and build tree
    const chunks: string[] = [];
    for (let i = 0; i < submissionContent.length; i += CHUNK_SIZE) {
      chunks.push(submissionContent.substring(i, i + CHUNK_SIZE));
    }
    const tree = MerkleTree.buildTree(chunks);
    const root = tree.getRoot();

    // Store for later proof generation
    this.activeRounds.set(roundId, { roundId, tree, chunks });

    // POST commit
    const url = `${coordinatorUrl}/research-rounds/${roundId}/v2/commit`;
    const body = {
      peerId,
      merkleRoot: root,
      leafCount: tree.getLeafCount(),
    };

    try {
      const res = await this.signedFetch(url, 'POST', body);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn(`[CommitRevealV2] Commit failed for round ${roundId}: ${res.status} ${text}`);
        return;
      }
      logger.log(
        `[CommitRevealV2] Committed merkle root for round ${roundId} ` +
        `(root: ${root.slice(0, 16)}…, ${chunks.length} chunks)`,
      );
    } catch (err) {
      logger.error(`[CommitRevealV2] Commit error for round ${roundId}: ${(err as Error).message}`);
    }
  }

  /**
   * Called when the coordinator broadcasts `round.v2.challenge_issued`.
   * Generates proofs for the challenged indices and POSTs them.
   */
  async handleChallengeResponse(
    coordinatorUrl: string,
    peerId: string,
    roundId: string,
    challengeIndices: number[],
  ): Promise<void> {
    const state = this.activeRounds.get(roundId);
    if (!state) {
      logger.warn(`[CommitRevealV2] No active V2 state for round ${roundId} — can't respond to challenge`);
      return;
    }

    // Generate proofs for each challenged index (clamped to tree size)
    const proofs: MerkleProof[] = [];
    for (const idx of challengeIndices) {
      if (idx < state.tree.getLeafCount()) {
        proofs.push(state.tree.getProof(idx));
      }
    }

    // POST proofs
    const url = `${coordinatorUrl}/research-rounds/${roundId}/v2/prove`;
    const body = { peerId, proofs };

    try {
      const res = await this.signedFetch(url, 'POST', body);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn(`[CommitRevealV2] Prove failed for round ${roundId}: ${res.status} ${text}`);
        return;
      }
      logger.log(
        `[CommitRevealV2] Submitted ${proofs.length} proofs for round ${roundId} ` +
        `(indices: [${challengeIndices.join(', ')}])`,
      );
    } catch (err) {
      logger.error(`[CommitRevealV2] Prove error for round ${roundId}: ${(err as Error).message}`);
    }

    // Cleanup — proofs sent, tree no longer needed
    this.activeRounds.delete(roundId);
  }

  // ─── Signed fetch helper ─────────────────────────────────────────────

  private async signedFetch(url: string, method: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (this._keypair && this._publicKey && this._peerId) {
      const parsedUrl = new URL(url);
      const pathStr = parsedUrl.pathname + parsedUrl.search;
      const auth = await buildAuthHeaders({
        method,
        path: pathStr,
        body,
        privateKey: this._keypair,
        publicKey: this._publicKey,
        peerId: this._peerId,
      });
      Object.assign(headers, auth);
    }

    return fetch(url, {
      method,
      headers,
      body: JSON.stringify(body),
    });
  }
}
