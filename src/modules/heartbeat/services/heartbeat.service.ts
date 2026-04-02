import { Injectable } from '@nestjs/common';
import {
  HeartbeatHelper,
  type HeartbeatPayload,
  type HeartbeatResponse,
} from '../heartbeat';
import type { Identity } from '../../identity/identity';
import type { Hardware } from '../../hardware/hardware';
import type { P2PNode } from '../../p2p/p2p';

@Injectable()
export class HeartbeatService {
  constructor(private readonly heartbeatHelper: HeartbeatHelper) {}

  send(coordinatorUrl: string, identity: Identity, hardware: Hardware): Promise<HeartbeatResponse> {
    return this.heartbeatHelper.sendHeartbeat(coordinatorUrl, identity, hardware);
  }

  startPeriodic(
    coordinatorUrl: string,
    identity: Identity,
    hardware: Hardware,
    intervalMs = 30000,
    p2pNode?: P2PNode,
  ): () => void {
    return this.heartbeatHelper.startPeriodicHeartbeat(coordinatorUrl, identity, hardware, intervalMs, p2pNode);
  }

  determineCapabilities(hardware: Hardware): string[] {
    return this.heartbeatHelper.determineCapabilities(hardware);
  }
}
