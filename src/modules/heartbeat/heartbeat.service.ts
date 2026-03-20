import { Injectable } from '@nestjs/common';
import {
  sendHeartbeat,
  startPeriodicHeartbeat,
  determineCapabilities,
  type HeartbeatPayload,
  type HeartbeatResponse,
} from '../../heartbeat.js';
import type { Identity } from '../../identity.js';
import type { Hardware } from '../../hardware.js';
import type { P2PNode } from '../../p2p.js';

@Injectable()
export class HeartbeatService {
  send(coordinatorUrl: string, identity: Identity, hardware: Hardware): Promise<HeartbeatResponse> {
    return sendHeartbeat(coordinatorUrl, identity, hardware);
  }

  startPeriodic(
    coordinatorUrl: string,
    identity: Identity,
    hardware: Hardware,
    intervalMs = 30000,
    p2pNode?: P2PNode,
  ): () => void {
    return startPeriodicHeartbeat(coordinatorUrl, identity, hardware, intervalMs, p2pNode);
  }

  determineCapabilities(hardware: Hardware): string[] {
    return determineCapabilities(hardware);
  }
}
