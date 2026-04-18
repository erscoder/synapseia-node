/**
 * node-runtime.ts — The actual node runtime.
 *
 * This is what runs when you do `syn start`. The CLI (cli/index.ts) is
 * responsible for resolving config, wallet, and identity — then it calls
 * startNode() here with a fully-resolved NodeRuntimeConfig.
 *
 * Nothing in here should ask the user for input or deal with the filesystem
 * for config/wallet purposes. That's the CLI's job.
 */

import type { Identity } from './modules/identity/identity';
import logger from './utils/logger';
import type { LLMModel, LLMConfig } from './modules/llm/llm-provider';
import { P2PNode } from './modules/p2p/p2p';
import { HeartbeatHelper } from './modules/heartbeat/heartbeat';
import { IpifyService } from './modules/shared/infrastructure/ipify.service';
import type { A2AServer } from './modules/a2a/a2a-server.service';

export interface NodeRuntimeConfig {
  /** Resolved peer identity (peerId, publicKey, privateKey) */
  identity: Identity;
  /** Human-readable node name (e.g. "node-alpha") */
  name: string;
  /** Wallet public key (Solana) */
  walletAddress: string;
  /** Hardware tier (1-5) */
  tier: number;
  /** Coordinator HTTP URL */
  coordinatorUrl: string;
  /** Node capabilities (e.g. ['llm', 'tier-1']) */
  capabilities: string[];
  /** Fully resolved LLM model */
  llmModel: LLMModel;
  /** LLM auth/connection config */
  llmConfig: LLMConfig;
  /** Work order polling interval in ms */
  intervalMs?: number;
  /** Max iterations (0 = unlimited) */
  maxIterations?: number;
  /** Latitude for geo-location (optional) */
  lat?: number;
  /** Longitude for geo-location (optional) */
  lng?: number;
  /** Enable A2A server (default: false) */
  a2aEnabled?: boolean;
  /** A2A server port (default: 7373) */
  a2aPort?: number;
}

export interface NodeRuntime {
  /** The running P2P node (if P2P started successfully) */
  p2pNode: P2PNode | null;
  /** Stop the node gracefully */
  stop: () => Promise<void>;
}

/**
 * Start the SYPNASEIA node runtime.
 *
 * Boots in order:
 *   1. P2P layer (libp2p) — peer discovery + gossipsub
 *   2. Work Order Agent — polls coordinator and executes tasks
 *
 * Returns a handle with a stop() method for graceful shutdown.
 */
export async function startNode(
  config: NodeRuntimeConfig,
  services: {
    p2pService: {
      createNode: (identity: Identity, bootstrapAddrs: string[]) => Promise<P2PNode>;
    };
    workOrderAgentService: {
      start: (cfg: {
        coordinatorUrl: string;
        peerId: string;
        capabilities: string[];
        llmModel: LLMModel;
        llmConfig: LLMConfig;
        intervalMs: number;
        maxIterations?: number;
      }) => Promise<void>;
      stop: () => void;
    };
    a2aServer?: A2AServer;
  },
): Promise<NodeRuntime> {
  // ── 1. P2P ────────────────────────────────────────────────────────────────
  logger.log(' Starting P2P layer...');
  let p2pNode: P2PNode | null = null;
  let currentCoordPeerId: string | null = null;
  const rawHost = config.coordinatorUrl
    .replace(/^https?:\/\//, '')
    .replace(/:\d+$/, '');
  const isLocalhost = rawHost === 'localhost' || rawHost === '127.0.0.1';
  const hostPrefix = isLocalhost ? '/ip4/127.0.0.1' : `/dns4/${rawHost}`;

  // Fetch the coord's libp2p peerId from HTTP so we can build a FULL
  // bootstrap multiaddr (`/dns4/host/tcp/9000/p2p/<peerId>`). Without
  // the `/p2p/<peerId>` suffix, @libp2p/bootstrap can't complete the
  // noise handshake — it doesn't know which peerId to expect on the
  // other end — and the coord/node libp2p peers never connect. The
  // chat auction then publishes into an empty gossip mesh and the
  // coord returns ALL_BIDS_FAILED with zero bids.
  const fetchCoordBootstrap = async (): Promise<string | null> => {
    try {
      const resp = await fetch(`${config.coordinatorUrl}/p2p/bootstrap`);
      if (!resp.ok) return null;
      const info = (await resp.json()) as { peerId: string; multiaddrs: string[] };
      return info?.peerId || null;
    } catch {
      return null;
    }
  };

  try {
    let bootstrapAddrs: string[] = [];
    const peerId = await fetchCoordBootstrap();
    if (peerId) {
      currentCoordPeerId = peerId;
      bootstrapAddrs = [`${hostPrefix}/tcp/9000/p2p/${peerId}`];
      logger.log(`   Coord libp2p peerId=${peerId.slice(0, 12)}… bootstrap=${bootstrapAddrs[0]}`);
    } else {
      logger.warn(`   ⚠️ Could not fetch /p2p/bootstrap — gossip will not connect until coord is reachable`);
    }

    p2pNode = await services.p2pService.createNode(config.identity, bootstrapAddrs);
    logger.log(`PeerID: ${p2pNode.getPeerId()}`);
    const addrs = p2pNode.getMultiaddrs();
    if (addrs.length > 0) {
      logger.log(`   Listening on: ${addrs.join(', ')}`);
    }
  } catch (err) {
    logger.warn(`⚠️P2P init failed — falling back to HTTP only: ${(err as Error).message}`);
  }

  // ── 1.5 Coord-reconnect watchdog ────────────────────────────────────────
  // If the coord restarts without a persisted libp2p identity (or the
  // `/app/data/libp2p-key` volume is wiped), its peerId changes. The old
  // bootstrap multiaddr in @libp2p/bootstrap is now invalid, the node
  // silently loses the mesh, heartbeat-over-HTTP keeps working (masking
  // the break), and every chat auction returns ALL_BIDS_FAILED.
  //
  // This watchdog polls /p2p/bootstrap every 30s. If the reported peerId
  // differs from the one we're actually connected to — or if we're not
  // connected at all — it redials on the new multiaddr. Cheap HTTP probe,
  // no-op on the happy path.
  let coordWatchdogHandle: NodeJS.Timeout | null = null;
  if (p2pNode) {
    const WATCHDOG_INTERVAL_MS = 30_000;
    const tick = async (): Promise<void> => {
      if (!p2pNode) return;
      try {
        const reported = await fetchCoordBootstrap();
        if (!reported) return; // coord down or unreachable — next tick will retry
        const connected = p2pNode.getConnectedPeers();
        const isConnected = connected.includes(reported);
        const peerChanged = currentCoordPeerId && currentCoordPeerId !== reported;
        if (!isConnected || peerChanged) {
          const newAddr = `${hostPrefix}/tcp/9000/p2p/${reported}`;
          logger.warn(
            `[CoordWatchdog] reconnecting — was=${currentCoordPeerId?.slice(0, 12) ?? 'none'}… ` +
              `now=${reported.slice(0, 12)}… connected=${isConnected} → dial ${newAddr}`,
          );
          try {
            await p2pNode.dial(newAddr);
            currentCoordPeerId = reported;
          } catch (dialErr) {
            logger.warn(`[CoordWatchdog] dial failed: ${(dialErr as Error).message} (will retry in ${WATCHDOG_INTERVAL_MS / 1000}s)`);
          }
        }
      } catch (err) {
        logger.warn(`[CoordWatchdog] tick error: ${(err as Error).message}`);
      }
    };
    coordWatchdogHandle = setInterval(() => { void tick(); }, WATCHDOG_INTERVAL_MS);
    logger.log(`[CoordWatchdog] polling /p2p/bootstrap every ${WATCHDOG_INTERVAL_MS / 1000}s`);
  }

  // ── 2. Heartbeat — send initial one before accepting work orders ─────────
  const heartbeatHelper = new HeartbeatHelper(new IpifyService());
  const hardware = { cpuCores: 0, ramGb: 0, gpuVramGb: 0, tier: config.tier, hasOllama: config.capabilities.includes('ollama'), hasCloudLlm: !!config.llmConfig?.baseUrl };

  logger.log('💓 Sending initial heartbeat (validating with coordinator)...');
  try {
    const response = await heartbeatHelper.sendHeartbeat(
      config.coordinatorUrl,
      config.identity,
      hardware,
      config.lat,
      config.lng,
      config.walletAddress,
    );
    logger.log(`   ✓ Heartbeat OK — registered: ${response.registered}, peerId: ${response.peerId}`);
  } catch (err) {
    logger.warn(`   ⚠️ Initial heartbeat failed (will retry periodically): ${(err as Error).message}`);
  }

  // Register models with coordinator (needed for WO routing)
  try {
    const { ModelDiscovery } = await import('./modules/discovery/model-discovery');
    const modelDiscovery = new ModelDiscovery();
    await modelDiscovery.registerModels(config.coordinatorUrl, config.identity.peerId, hardware, config.identity, config.llmConfig?.baseUrl);
    logger.log('   ✓ Models registered with coordinator');
  } catch (err) {
    logger.warn(`   ⚠️ Model registration failed (non-critical): ${(err as Error).message}`);
  }

  // Start periodic heartbeat in background
  const heartbeatCleanup = heartbeatHelper.startPeriodicHeartbeat(
    config.coordinatorUrl,
    config.identity,
    hardware,
    config.intervalMs ?? 30000,
    p2pNode ?? undefined,
    config.lat,
    config.lng,
    config.walletAddress,
    config.llmConfig?.baseUrl,
  );
  logger.log(`   Coordinator: ${config.coordinatorUrl}`);
  logger.log(`   Interval: ${((config.intervalMs ?? 30000) / 1000).toFixed(0)}s`);

  // ── 3. A2A Server (Sprint D) ──────────────────────────────────────────────
  let a2aRunning = false;
  const a2aEnabled = config.a2aEnabled ?? (process.env.A2A_ENABLED === 'true');
  if (a2aEnabled && services.a2aServer) {
    const a2aPort = config.a2aPort ?? (Number(process.env.A2A_PORT) || 7373);
    try {
      await services.a2aServer.start(a2aPort);
      a2aRunning = true;
      logger.log(`🤝 A2A server listening on port ${a2aPort}`);
    } catch (err) {
      logger.warn(`⚠️ A2A server failed to start: ${(err as Error).message}`);
    }
  } else if (a2aEnabled) {
    logger.warn('⚠️ A2A_ENABLED=true but A2AServer service not provided — skipping');
  }

  // ── 3.5 Inference server (OpenAI-compatible + Vickrey bid endpoint) ─────
  // Exposes POST /v1/chat/completions (coordinator forwards chat here once
  // the user paid) and POST /inference/quote (Vickrey bid). Port defaults
  // to 8080, configurable via INFERENCE_PORT. Skipped if
  // INFERENCE_SERVER_DISABLED=true (for tiny nodes that only train).
  //
  // Note: as of PR-2, auction + chat forwarding prefer libp2p (GossipSub
  // bids + /synapseia/chat/1.0.0 stream). The HTTP server stays alive for
  // rolling upgrades (coord falls back to HTTP if the libp2p stream dial
  // fails). Once every node in the network serves the stream protocol the
  // HTTP server can be retired.
  if (process.env.INFERENCE_SERVER_DISABLED !== 'true') {
    try {
      const { startInferenceServer } = await import('./modules/inference/inference-server');
      const inferencePort = Number(process.env.INFERENCE_PORT) || 8080;
      const localModels = config.llmConfig?.baseUrl
        ? await (async () => {
            try {
              const { ModelCatalogHelper } = await import('./modules/model/model-catalog');
              return new ModelCatalogHelper().getLocalModels(config.llmConfig!.baseUrl);
            } catch { return [] as string[]; }
          })()
        : [];
      startInferenceServer({
        port: inferencePort,
        peerId: config.identity.peerId,
        tier: config.tier,
        models: localModels,
        coordinatorUrl: config.coordinatorUrl,
      });
      logger.log(`🧠 Inference server listening on port ${inferencePort}`);
    } catch (err) {
      logger.warn(`⚠️ Inference server failed to start: ${(err as Error).message}`);
    }
  }

  // ── 3.6 Chat: GossipSub bid responder + libp2p chat stream handler ──────
  // Only wire if P2P is running. BidResponder self-filters on inference
  // capability — train-only nodes just idle. ChatStreamHandler registers a
  // libp2p protocol handler and scales with the gossip mesh.
  if (p2pNode) {
    try {
      const { BidResponder } = await import('./modules/inference/bid-responder');
      new BidResponder(p2pNode, {
        capabilities: config.capabilities,
        identity: config.identity,
      }).start();
    } catch (err) {
      logger.warn(`⚠️ BidResponder failed to start: ${(err as Error).message}`);
    }
    try {
      const { ChatStreamHandler } = await import('./modules/inference/chat-stream-handler');
      await new ChatStreamHandler(p2pNode).start();
    } catch (err) {
      logger.warn(`⚠️ ChatStreamHandler failed to start: ${(err as Error).message}`);
    }
  } else {
    logger.warn('⚠️ P2P not running — chat auction/stream over libp2p skipped (HTTP fallback only)');
  }

  // ── 4. Work Order Agent ───────────────────────────────────────────────────
  logger.log('..............................');
  logger.log('🚀 Starting LangGraph work order agent...');
  logger.log(`   Coordinator: ${config.coordinatorUrl}`);
  logger.log(`   Capabilities: ${config.capabilities.join(', ')}`);
  logger.log(`   Model: ${config.llmModel.providerId ? config.llmModel.providerId + '/' : ''}${config.llmModel.modelId}`);
  logger.log(`   Interval: ${((config.intervalMs ?? 30000) / 1000).toFixed(0)}s`);
  logger.log(`   Mode: langgraph`);

  // Fire and forget — the LangGraph agent loop runs indefinitely
  services.workOrderAgentService
    .start({
      coordinatorUrl: config.coordinatorUrl,
      peerId: config.identity.peerId,
      capabilities: config.capabilities,
      llmModel: config.llmModel,
      llmConfig: config.llmConfig,
      intervalMs: config.intervalMs ?? 30000,
      maxIterations: config.maxIterations,
    })
    .catch((err: Error) => {
      logger.error('❌ LangGraph agent crashed:', err.message);
    });


  return {
    p2pNode,
    stop: async () => {
      logger.log('🛑 Shutting down node...');
      if (coordWatchdogHandle) clearInterval(coordWatchdogHandle);
      heartbeatCleanup();
      services.workOrderAgentService.stop();
      if (a2aRunning && services.a2aServer) {
        try { services.a2aServer.stop(); } catch { /* ignore */ }
      }
      if (p2pNode) {
        try {
          await (p2pNode as unknown as { stop?: () => Promise<void> }).stop?.();
        } catch {
          // ignore
        }
      }
      logger.log('✅ Node stopped.');
    },
  };
}
