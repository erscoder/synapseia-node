/* eslint-disable @typescript-eslint/no-explicit-any */
import { createLibp2p } from 'libp2p';
import { setMaxListeners } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import logger from '../../utils/logger';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { gossipsub } from '@libp2p/gossipsub';
import { kadDHT } from '@libp2p/kad-dht';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { Injectable } from '@nestjs/common';
import type { Identity } from '../identity/identity';
import { sign, canonicalPayload } from '../identity/identity';

const SYNAPSEIA_HOME = process.env.SYNAPSEIA_HOME ?? path.join(os.homedir(), '.synapseia');
const LIBP2P_KEY_PATH = path.join(SYNAPSEIA_HOME, 'libp2p-key');

export const TOPICS = {
  HEARTBEAT: '/synapseia/heartbeat/1.0.0',
  SUBMISSION: '/synapseia/submission/1.0.0',
  LEADERBOARD: '/synapseia/leaderboard/1.0.0',
  PULSE: '/synapseia/pulse/1.0.0',
  /** Auction requests from the coordinator. Nodes with `inference` capability
   *  listen, compute a local price via QueryCostCalculator, and publish to
   *  CHAT_BID. */
  CHAT_AUCTION: '/synapseia/chat-auction/1.0.0',
  /** Signed bids published by nodes, consumed by the coordinator. */
  CHAT_BID: '/synapseia/chat-bid/1.0.0',
} as const;

/** Libp2p protocol the winning node serves to accept the grounded prompt +
 *  write back the OpenAI-shaped response. Runs over the same libp2p
 *  connection used for gossip — no extra TCP/TLS. */
export const CHAT_PROTOCOL = '/synapseia/chat/1.0.0';

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];
type MsgCb = (data: Record<string, unknown>, from: string) => void;

export class P2PNode {
  private node: any = null;
  private handlers: Map<string, MsgCb[]> = new Map();

  constructor(private readonly identity: Identity) {}

  async start(bootstrapAddrs: string[] = []): Promise<void> {
    // Load or generate the libp2p Ed25519 keypair. Persisting to disk means
    // the peerId stays stable across node restarts — critical for the gossip
    // mesh (coord + other nodes cache the multiaddr with the peerId embedded).
    const keysModule = await import('@libp2p/crypto/keys');
    const privateKey = await this.loadOrCreateKey(keysModule);

    const svcBase = {
      identify: identify(),
      ping: ping(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false }),
      dht: kadDHT({ clientMode: bootstrapAddrs.length === 0 }),
    } as const;

    const svc = bootstrapAddrs.length > 0
      ? { ...svcBase, bootstrap: bootstrap({ list: bootstrapAddrs }) }
      : svcBase;

    this.node = await createLibp2p({
      privateKey,
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
    logger.log('[P2P] Node started | peerId:', peerId);
    if (addrs.length > 0) logger.log('[P2P] Listening on:', addrs.join(', '));

    // Bump AbortSignal listeners limit — libp2p/ping creates many internally
    try {
      setMaxListeners(20, this.node as any);
      logger.log(`[P2P] setMaxListeners(20) on node (ping service uses AbortSignals)`);
    } catch (err) {
      // Not a real EventTarget in test mocks — skip
    }

    // Log peer discovery and connection events
    this.node.addEventListener('peer:discovery', (evt: any) => {
      const id = evt.detail?.id?.toString() ?? 'unknown';
      logger.log('[P2P] 🔍 Peer discovered:', id);
    });
    this.node.addEventListener('peer:connect', (evt: any) => {
      const id = evt.detail?.toString() ?? 'unknown';
      logger.log('[P2P] ✅ Peer connected:', id);
    });
    this.node.addEventListener('peer:disconnect', (evt: any) => {
      const id = evt.detail?.toString() ?? 'unknown';
      logger.log('[P2P] ❌ Peer disconnected:', id);
    });
  }

  private async loadOrCreateKey(keys: typeof import('@libp2p/crypto/keys')): Promise<any> {
    try {
      const bytes = fs.readFileSync(LIBP2P_KEY_PATH);
      const key = keys.privateKeyFromProtobuf(new Uint8Array(bytes));
      logger.log(`[P2P] loaded persistent identity from ${LIBP2P_KEY_PATH}`);
      return key;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        logger.warn(`[P2P] could not read ${LIBP2P_KEY_PATH} (${err.message}) — generating fresh key`);
      }
      const key = await keys.generateKeyPair('Ed25519');
      try {
        fs.mkdirSync(path.dirname(LIBP2P_KEY_PATH), { recursive: true, mode: 0o700 });
        fs.writeFileSync(LIBP2P_KEY_PATH, keys.privateKeyToProtobuf(key), { mode: 0o600 });
        logger.log(`[P2P] generated + persisted new identity at ${LIBP2P_KEY_PATH} — restarts will keep the same peerId`);
      } catch (writeErr: any) {
        logger.warn(
          `[P2P] generated key but FAILED to persist at ${LIBP2P_KEY_PATH} (${writeErr.message}) — ` +
            `peerId will change on next restart. Check the volume mount.`,
        );
      }
      return key;
    }
  }

  async stop(): Promise<void> {
    if (this.node) {
      await this.node.stop();
      this.node = null;
      logger.log('[P2P] Node stopped');
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

  /**
   * Register an inbound libp2p protocol handler. libp2p v3 calls the
   * handler with TWO POSITIONAL arguments — `(stream, connection)` — not
   * an object. Passing a `(ctx) => ctx.stream` handler silently yields
   * `undefined` on every inbound stream (ctx is actually the Stream
   * itself; no `stream` property exists), so our codec call crashes on
   * `for await (const chunk of undefined)` and the peer times out.
   */
  async handleProtocol(
    protocol: string,
    handler: (stream: any, connection: any) => void | Promise<void>,
  ): Promise<void> {
    if (!this.node) throw new Error('P2P node not started');
    await this.node.handle(protocol, handler);
  }

  /** Access the raw libp2p node — only for helpers that need fine-grained API. */
  getNode(): any {
    return this.node;
  }

  /**
   * Dial a full multiaddr (`/dns4/.../tcp/9000/p2p/<peerId>`). Used by the
   * coord-reconnect watchdog in node-runtime when the coord's libp2p peerId
   * has changed (coord restart without persisted identity, or the volume
   * was wiped). Returns silently on failure so the watchdog can retry.
   */
  async dial(multiaddr: string): Promise<void> {
    if (!this.node) throw new Error('P2P node not started');
    const { multiaddr: ma } = await import('@multiformats/multiaddr');
    await this.node.dial(ma(multiaddr));
  }
}

@Injectable()
export class P2pHelper {
  async createP2PNode(
    identity: Identity,
    bootstrapAddrs: string[] = [],
  ): Promise<P2PNode> {
    const node = new P2PNode(identity);
    await node.start(bootstrapAddrs);
    return node;
  }
}

// Backward-compatible standalone export

