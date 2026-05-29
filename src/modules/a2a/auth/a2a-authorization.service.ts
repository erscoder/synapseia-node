/**
 * A2A Authorization Service
 *
 * FINDING 1 (authorization allowlist): signature verification only proves
 * *who* sent a task; it does not prove they are *allowed* to. This service
 * is the authorization layer that decides whether a given (peerId, taskType)
 * pair is permitted, using the existing trust roots rather than inventing a
 * new registry:
 *
 *  - Trust anchor: the hardcoded coordinator Ed25519 pubkey
 *    (`COORDINATOR_PUBKEY_BASE58`, see p2p/protocols/coordinator-pubkey.ts).
 *    The coordinator peerId derives from it the same way node peerIds derive
 *    from their pubkeys (`publicKeyHex.slice(0, 32)`), so the coordinator is
 *    authorized for every task type.
 *  - Known peers: peers present in `PeerRegistryService` (populated from
 *    authenticated libp2p heartbeats) are authorized for the standard
 *    peer-to-peer task types.
 *
 * Default-deny: a peerId that is neither the coordinator nor a live known
 * peer is rejected. Privileged task types (`delegate_research`) require a
 * known peer; `health_check` is allowed for any authenticated (signature +
 * identity-bound) caller so liveness probes keep working.
 */

import { Injectable } from '@nestjs/common';
import { PeerRegistryService } from '../client/peer-registry.service';
import {
  COORDINATOR_PUBKEY_BASE58,
  loadCoordinatorPubkey,
} from '../../../p2p/protocols/coordinator-pubkey';
import type { A2ATaskType } from '../types';

/**
 * Task types that any signature-authenticated caller may invoke, even if we
 * have never seen them in the peer registry. Liveness only — no side effects
 * on local state beyond a health response.
 */
const PUBLICLY_REACHABLE_TASK_TYPES: ReadonlySet<A2ATaskType> = new Set<A2ATaskType>([
  'health_check',
]);

@Injectable()
export class A2AAuthorizationService {
  /** Coordinator peerId derived from the hardcoded trust anchor. */
  private readonly coordinatorPeerId: string;

  constructor(private readonly peerRegistry: PeerRegistryService) {
    this.coordinatorPeerId = deriveCoordinatorPeerId();
  }

  /**
   * Decide whether `senderPeerId` is authorized to invoke `taskType`.
   * Assumes the caller has ALREADY passed signature + identity-binding
   * verification (A2AAuthService.verify). Returns false on any doubt.
   */
  isAuthorized(senderPeerId: string, taskType: A2ATaskType): boolean {
    if (!senderPeerId) return false;
    const peerId = senderPeerId.toLowerCase();

    // The coordinator is the network trust root — authorized for everything.
    if (this.coordinatorPeerId && peerId === this.coordinatorPeerId) {
      return true;
    }

    // Liveness probes are allowed for any authenticated caller.
    if (PUBLICLY_REACHABLE_TASK_TYPES.has(taskType)) {
      return true;
    }

    // Everything else requires a live, known peer from the authenticated
    // heartbeat-fed registry. Default-deny otherwise.
    return this.isKnownLivePeer(peerId);
  }

  /** Expose the derived coordinator peerId (testing / diagnostics). */
  getCoordinatorPeerId(): string {
    return this.coordinatorPeerId;
  }

  private isKnownLivePeer(peerId: string): boolean {
    // PeerRegistry keys are the peerIds as advertised over libp2p. Compare
    // case-insensitively to stay consistent with the binding check.
    for (const info of this.peerRegistry.getLivePeers()) {
      if (info.peerId.toLowerCase() === peerId) return true;
    }
    return false;
  }
}

/**
 * Derive the coordinator peerId from the hardcoded base58 trust anchor.
 *
 * Node peerIds are `publicKeyHex.slice(0, 32)` (first 16 bytes of the raw
 * 32-byte Ed25519 pubkey, hex). We reproduce that derivation for the
 * coordinator so a coordinator-signed A2A task can be recognized. Returns
 * an empty string only if the constant is somehow corrupted (a broken
 * release), in which case the coordinator simply won't match and callers
 * fall back to the known-peer path.
 */
function deriveCoordinatorPeerId(): string {
  try {
    void COORDINATOR_PUBKEY_BASE58; // documents the source of truth
    const raw = loadCoordinatorPubkey(); // 32-byte Uint8Array
    const hex = Buffer.from(raw).toString('hex'); // 64 hex chars
    return hex.slice(0, 32).toLowerCase();
  } catch {
    return '';
  }
}
