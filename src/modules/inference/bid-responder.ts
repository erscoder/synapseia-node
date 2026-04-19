/**
 * BidResponder — subscribes to /synapseia/chat-auction/1.0.0, computes a
 * local price via the shared QueryCostCalculator, and publishes a signed
 * Bid to /synapseia/chat-bid/1.0.0.
 *
 * This is the node side of the Vickrey auction moved from HTTP fan-out to
 * GossipSub. The coordinator reads the CHAT_BID topic, so the node doesn't
 * need an open inbound HTTP port for bids — scales natively to 100k nodes
 * via the libp2p gossip mesh.
 *
 * Self-filter: we only bid if this node has `inference` as one of its
 * declared capabilities. Nodes without that cap still receive the gossip
 * (subscription is per-topic, not per-cap) but no-op on the message.
 */
import logger from '../../utils/logger';
import { P2PNode, TOPICS } from '../p2p/p2p';
import { computeQueryPriceUsd } from './QueryCostCalculator';
import type { Identity } from '../identity/identity';
import { sign, canonicalPayload } from '../identity/identity';
import type { SynapseiaServingClient } from '../llm/synapseia-serving-client';

export interface BidResponderConfig {
  capabilities: string[];
  identity: Identity;
  /**
   * F3-C2 — optional Synapseia serving client. When present AND it
   * reports an active model version, the bid advertises
   * `modelVersion` so the coord's auction can apply the
   * `MIN_REQUIRED_MODEL_VERSION` filter. Nodes without the client
   * stay cloud-only and simply don't advertise a version.
   */
  synapseiaClient?: SynapseiaServingClient;
}

const DEFAULT_MIN = 0.1;
const DEFAULT_MAX = 1.0;

export class BidResponder {
  constructor(
    private readonly p2p: P2PNode,
    private readonly config: BidResponderConfig,
  ) {}

  start(): void {
    if (!this.config.capabilities.includes('inference') &&
        !this.config.capabilities.includes('cpu_inference') &&
        !this.config.capabilities.includes('gpu_inference')) {
      logger.log('[BidResponder] node has no inference capability — not listening for auctions');
      return;
    }
    // Subscribe to the auction topic. libp2p subscriptions are already
    // opened in P2PNode.start(); we only need to register the handler.
    this.p2p.onMessage(TOPICS.CHAT_AUCTION, (data) => {
      void this.handleAuction(data as Record<string, unknown>);
    });
    logger.log('[BidResponder] listening on /synapseia/chat-auction/1.0.0');
  }

  private async handleAuction(msg: Record<string, unknown>): Promise<void> {
    const quoteId = typeof msg.quoteId === 'string' ? msg.quoteId : null;
    const query = typeof msg.query === 'string' ? msg.query : null;
    const deadline = typeof msg.deadline === 'number' ? msg.deadline : 0;
    if (!quoteId || !query) return;
    if (deadline && deadline < Date.now()) {
      // Stale auction — coordinator already closed it. Ignore.
      return;
    }

    const minPriceUsd = parseFloat(process.env.QUERY_MIN_PRICE ?? String(DEFAULT_MIN));
    const maxPriceUsd = parseFloat(process.env.QUERY_MAX_PRICE ?? String(DEFAULT_MAX));
    const priceUsd = computeQueryPriceUsd(query, { minPriceUsd, maxPriceUsd });

    // F3-C2/C6 — advertise the Synapseia model version this node is
    // currently serving. The value MUST be part of the signed canonical
    // so a malicious node can't inflate its advertised version after
    // signing a legitimate price.
    const modelVersion = this.config.synapseiaClient?.getActiveVersion() ?? undefined;

    // Sign the bid with Ed25519 (same pattern as heartbeat). The coord
    // verifies this against the peer's publicKey to prevent spoofing.
    const canonical = canonicalPayload({
      quoteId,
      peerId: this.config.identity.peerId,
      priceUsd,
      modelVersion: modelVersion ?? '',
    });
    const signature = await sign(canonical, this.config.identity.privateKey);

    try {
      // libp2pPeerId is the base58 CID-style id every libp2p connection uses
      // internally (e.g. `12D3Koo…`). The coord dials the winner on this
      // string via `dialProtocol` — if we only sent `identity.peerId` (the
      // Synapseia-style hex hash), `getConnections().find(c =>
      // remotePeer.toString() === peerId)` never matches and /chat/send
      // throws NODE_FAILED. Shipping both keeps the registry/payment flows
      // unchanged (they keep using the Synapseia peerId) while fixing the
      // libp2p dial.
      const libp2pPeerId = this.p2p.getPeerId();
      await this.p2p.publish(TOPICS.CHAT_BID, {
        version: 1,
        quoteId,
        peerId: this.config.identity.peerId,
        libp2pPeerId,
        priceUsd,
        modelVersion,
        publicKey: this.config.identity.publicKey,
        signature,
      });
      logger.log(
        `[BidResponder] bid $${priceUsd} for quote ${quoteId.slice(0, 8)}… libp2p=${libp2pPeerId.slice(0, 12)}…` +
          (modelVersion ? ` mv=${modelVersion}` : ''),
      );
    } catch (err) {
      logger.warn(`[BidResponder] publish failed for quote ${quoteId.slice(0, 8)}…: ${(err as Error).message}`);
    }
  }
}
