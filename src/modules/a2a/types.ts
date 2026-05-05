/**
 * A2A Protocol Types
 * Sprint D — A2A Server for Synapseia Node
 */

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
}

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  skills: A2ASkill[];
  authentication: {
    schemes: string[];
  };
  metadata: {
    /** Hardware class (VRAM-bucket-derived, range 0-5). Self-reported by the
     *  node. Mirror of the heartbeat `hardwareClass` field — never the
     *  staking tier. */
    hardwareClass: number;
    /** Optional staking tier (SYN-stake-derived, range 0-5). Populated when
     *  the runtime has resolved the wallet's on-chain stake; left undefined
     *  otherwise so consumers can distinguish "no stake info" from
     *  "tier 0". */
    stakingTier?: number;
    domain: string;
    uptime: number;
    peerId: string;
  };
}

export type A2ATaskType =
  | 'peer_review'
  | 'embedding_request'
  | 'knowledge_query'
  | 'delegate_research'
  | 'health_check';

export interface A2ATask {
  id: string;
  type: A2ATaskType;
  payload: Record<string, unknown>;
  senderPeerId: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

export interface A2ATaskResult {
  taskId: string;
  success: boolean;
  data: unknown;
  error?: string;
  processingMs: number;
}

export interface A2ARequest {
  task: A2ATask;
  headers: Record<string, string>;
}

export interface A2ANodeConfig {
  peerId: string;
  /** Hardware class (VRAM-bucket-derived, range 0-5). Mirror of the
   *  heartbeat `hardwareClass` field. */
  hardwareClass: number;
  /** Optional staking tier (SYN-stake-derived). Set by node-runtime when the
   *  wallet's on-chain stake is known. */
  stakingTier?: number;
  domain: string;
  capabilities: string[];
  a2aPort: number;
  a2aHost?: string;
  version?: string;
}
