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

import type { Identity } from './modules/identity/identity.js';
import type { LLMModel, LLMConfig } from './modules/llm/llm-provider.js';
import { P2PNode } from './modules/p2p/p2p.js';
import { HeartbeatHelper } from './modules/heartbeat/heartbeat.js';

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
  },
): Promise<NodeRuntime> {
  // ── 1. P2P ────────────────────────────────────────────────────────────────
  console.log('\n🌐 Starting P2P layer...');
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
    console.log(`   ✅ PeerID: ${p2pNode.getPeerId()}`);
    const addrs = p2pNode.getMultiaddrs();
    if (addrs.length > 0) {
      console.log(`   Listening on: ${addrs.join(', ')}`);
    }
  } catch (err) {
    console.warn(`   ⚠️  P2P init failed — falling back to HTTP only: ${(err as Error).message}`);
  }

  // ── 2. Heartbeat ──────────────────────────────────────────────────────────
  console.log('\n💓 Starting heartbeat loop...');
  const heartbeatHelper = new HeartbeatHelper();
  const heartbeatCleanup = heartbeatHelper.startPeriodicHeartbeat(
    config.coordinatorUrl,
    config.identity,
    { cpuCores: 0, ramGb: 0, gpuVramGb: 0, tier: config.tier, hasOllama: config.capabilities.includes('ollama') },
    config.intervalMs ?? 30000,
    p2pNode ?? undefined,
  );
  console.log(`   Coordinator: ${config.coordinatorUrl}`);
  console.log(`   Interval: ${((config.intervalMs ?? 30000) / 1000).toFixed(0)}s`);

  // ── 3. Work Order Agent ───────────────────────────────────────────────────
  console.log('\n🚀 Starting work order agent...');
  console.log(`   Coordinator: ${config.coordinatorUrl}`);
  console.log(`   Capabilities: ${config.capabilities.join(', ')}`);
  console.log(`   Model: ${config.llmModel.providerId ? config.llmModel.providerId + '/' : ''}${config.llmModel.modelId}`);
  console.log(`   Interval: ${((config.intervalMs ?? 30000) / 1000).toFixed(0)}s`);

  // Fire and forget — the agent loop runs indefinitely
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
      console.error('❌ Work order agent crashed:', err.message);
    });


  return {
    p2pNode,
    stop: async () => {
      console.log('\n🛑 Shutting down node...');
      heartbeatCleanup();
      services.workOrderAgentService.stop();
      if (p2pNode) {
        try {
          await (p2pNode as unknown as { stop?: () => Promise<void> }).stop?.();
        } catch {
          // ignore
        }
      }
      console.log('✅ Node stopped.');
    },
  };
}
