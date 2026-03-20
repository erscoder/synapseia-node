import { Injectable } from '@nestjs/common';
import { P2PNode, createP2PNode, TOPICS } from '../../p2p.js';
import type { Identity } from '../../identity.js';

@Injectable()
export class P2pService {
  createNode(identity: Identity, bootstrapAddrs: string[] = []): Promise<P2PNode> {
    return createP2PNode(identity, bootstrapAddrs);
  }

  get topics() {
    return TOPICS;
  }
}
