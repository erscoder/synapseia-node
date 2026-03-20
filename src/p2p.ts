/* eslint-disable @typescript-eslint/no-explicit-any */
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { gossipsub } from '@libp2p/gossipsub';
import { kadDHT } from '@libp2p/kad-dht';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import type { Identity } from './identity.js';
import { sign, canonicalPayload } from './identity.js';

export const TOPICS = {
  HEARTBEAT: '/synapseia/heartbeat/1.0.0',
  SUBMISSION: '/synapseia/submission/1.0.0',
  LEADERBOARD: '/synapseia/leaderboard/1.0.0',
  PULSE: '/synapseia/pulse/1.0.0',
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];
type MsgCb = (data: Record<string, unknown>, from: string) => void;

export class P2PNode {
  private node: any = null;
  private handlers: Map<string, MsgCb[]> = new Map();

  constructor(private readonly identity: Identity) {}

  async start(bootstrapAddrs: string[] = []): Promise<void> {
    const svcBase = {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false }),
      dht: kadDHT({ clientMode: bootstrapAddrs.length === 0 }),
    } as const;

    const svc = bootstrapAddrs.length > 0
      ? { ...svcBase, bootstrap: bootstrap({ list: bootstrapAddrs }) }
      : svcBase;

    this.node = await createLibp2p({
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: svc as any,
    });
    await this.node.start();

    this.node.services.pubsub.addEventListener('message', (evt: any) => {
      try {
        const { topic, data, from } = evt.detail;
        const parsed = JSON.parse(new TextDecoder().decode(data as Uint8Array));
        for (const cb of (this.handlers.get(topic as string) ?? [])) {
          cb(parsed as Record<string, unknown>, from?.toString() ?? 'unknown');
        }
      } catch {
        // ignore malformed messages
      }
    });

    for (const t of Object.values(TOPICS)) {
      this.node.services.pubsub.subscribe(t);
    }

    const peerId: string = this.node.peerId.toString();
    const addrs: string[] = this.node.getMultiaddrs().map((a: any) => a.toString() as string);
    console.log('[P2P] Node started | peerId:', peerId);
    if (addrs.length > 0) console.log('[P2P] Listening on:', addrs.join(', '));
  }

  async stop(): Promise<void> {
    if (this.node) {
      await this.node.stop();
      this.node = null;
      console.log('[P2P] Node stopped');
    }
  }

  isRunning(): boolean {
    return this.node !== null;
  }

  getPeerId(): string {
    if (!this.node) return this.identity.peerId;
    return this.node.peerId.toString() as string;
  }

  getConnectedPeers(): string[] {
    if (!this.node) return [];
    return (this.node.getPeers() as any[]).map((p: any) => p.toString() as string);
  }

  getMultiaddrs(): string[] {
    if (!this.node) return [];
    return (this.node.getMultiaddrs() as any[]).map((a: any) => a.toString() as string);
  }

  onMessage(topic: string, cb: MsgCb): void {
    const existing = this.handlers.get(topic) ?? [];
    this.handlers.set(topic, [...existing, cb]);
  }

  async publish(topic: string, data: Record<string, unknown>): Promise<void> {
    if (!this.node) throw new Error('P2P node not started');
    const encoded = new TextEncoder().encode(JSON.stringify(data));
    await this.node.services.pubsub.publish(topic, encoded);
  }

  async publishHeartbeat(data: Record<string, unknown>): Promise<void> {
    const payload = { ...data };
    const canonical = canonicalPayload(payload);
    const signature = await sign(canonical, this.identity.privateKey);
    // BUG-2 fix: Use full 32-byte publicKey instead of peerId (truncated 16 bytes)
    // P2PHeartbeatBridge expects publicKey for Ed25519 verification
    return this.publish(TOPICS.HEARTBEAT, { ...payload, signature, publicKey: this.identity.publicKey });
  }

  async publishSubmission(data: Record<string, unknown>): Promise<void> {
    return this.publish(TOPICS.SUBMISSION, data);
  }
}

export async function createP2PNode(
  identity: Identity,
  bootstrapAddrs: string[] = [],
): Promise<P2PNode> {
  const node = new P2PNode(identity);
  await node.start(bootstrapAddrs);
  return node;
}