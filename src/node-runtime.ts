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
  try {
    const rawHost = config.coordinatorUrl
      .replace(/^https?:\/\//, '')
      .replace(/:\d+$/, '');
    const isLocalhost = rawHost === 'localhost' || rawHost === '127.0.0.1';
    const bootstrapAddrs = rawHost
      ? [isLocalhost ? `/ip4/127.0.0.1/tcp/9000` : `/dns4/${rawHost}/tcp/9000`]
      : [];

    p2pNode = await services.p2pService.createNode(config.identity, bootstrapAddrs);
    logger.log(`PeerID: ${p2pNode.getPeerId()}`);
    const addrs = p2pNode.getMultiaddrs();
    if (addrs.length > 0) {
      logger.log(`   Listening on: ${addrs.join(', ')}`);
    }
  } catch (err) {
    logger.warn(`⚠️P2P init failed — falling back to HTTP only: ${(err as Error).message}`);
  }

  // ── 2. Heartbeat ──────────────────────────────────────────────────────────
  logger.log('💓 Starting heartbeat loop...');
  const heartbeatHelper = new HeartbeatHelper();
  const heartbeatCleanup = heartbeatHelper.startPeriodicHeartbeat(
    config.coordinatorUrl,
    config.identity,
    { cpuCores: 0, ramGb: 0, gpuVramGb: 0, tier: config.tier, hasOllama: config.capabilities.includes('ollama'), hasCloudLlm: !!config.llmConfig?.baseUrl },
    config.intervalMs ?? 30000,
    p2pNode ?? undefined,
    config.lat,
    config.lng,
    config.walletAddress, // Solana wallet address for reward payouts
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
