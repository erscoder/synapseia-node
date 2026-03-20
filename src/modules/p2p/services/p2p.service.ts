import { Injectable } from '@nestjs/common';
import { P2pHelper, P2PNode, TOPICS } from '../p2p.js';
import type { Identity } from '../../identity/identity.js';

@Injectable()
export class P2pService {
  constructor(private readonly p2pHelper: P2pHelper) {}

  createNode(identity: Identity, bootstrapAddrs: string[] = []): Promise<P2PNode> {
    return this.p2pHelper.createP2PNode(identity, bootstrapAddrs);
  }

  get topics() {
    return TOPICS;
  }
}
