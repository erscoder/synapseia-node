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
    tier: number;
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
  tier: number;
  domain: string;
  capabilities: string[];
  a2aPort: number;
  a2aHost?: string;
  version?: string;
}
