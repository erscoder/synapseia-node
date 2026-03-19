/**
 * Work Order Agent - Polling loop for work order execution
 *
 * Loop principal:
 * 1. Poll /work-orders/available from coordinator
 * 2. Accept assignable work order
 * 3. Execute work (research, calculation, etc.)
 * 4. Report result to coordinator
 * 5. Sleep and repeat
 */

import { generateLLM, type LLMConfig } from './llm-provider.js';
import { parseModel, type LLMModel } from './llm-provider.js';
import type { AgentBrain } from './agent-brain.js';

/**
 * Parse rewardAmount string to lamports BigInt.
 * The coordinator API returns SYN as decimal string e.g. "100.000000000"
 * (9 decimal places = lamports). BigInt() cannot handle decimals, so we
 * strip the decimal point and convert directly.
 */
function parseSynToLamports(rewardStr: string): bigint {
  if (!rewardStr) return 0n;
  // If it already looks like a plain integer (no dot), convert directly
  if (!rewardStr.includes('.')) return BigInt(rewardStr);
  // "100.000000000" → integer part "100", decimal part "000000000" (9 digits)
  const [intPart, decPart = ''] = rewardStr.split('.');
  const decimals = 9;
  const paddedDec = decPart.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(intPart) * 1_000_000_000n + BigInt(paddedDec);
}

export interface WorkOrderAgentConfig {
  coordinatorUrl: string;
  peerId: string;
  capabilities: string[];
  llmModel: LLMModel;
  llmConfig?: LLMConfig;
  intervalMs: number;
  maxIterations?: number;
}

export interface WorkOrder {
  id: string;
  title: string;
  description: string;
  requiredCapabilities: string[];
  rewardAmount: string; // BigInt as string
  status: 'PENDING' | 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  creatorAddress: string;
  assigneeAddress?: string;
  createdAt: number;
  expiresAt?: number;
  type?: 'TRAINING' | 'RESEARCH' | 'INFERENCE';
}

export interface ResearchPayload {
  title: string;
  abstract: string;
}

export interface ResearchResult {
  summary: string;
  keyInsights: string[];
  proposal: string;
}

export interface WorkOrderAgentState {
  iteration: number;
  totalWorkOrdersCompleted: number;
  totalRewardsEarned: bigint;
  isRunning: boolean;
  currentWorkOrder?: WorkOrder;
}

/**
 * Economic configuration for rational node behavior
 * Controls bounty evaluation and profit thresholds
 */
export interface EconomicConfig {
  /** SYN price in USD for testnet calculations */
  synPriceUsd: number;
  /** LLM type: 'ollama' (local, $0 cost) or 'cloud' (paid API) */
  llmType: 'ollama' | 'cloud';
  /** LLM model identifier (e.g., 'gpt-4o-mini', 'claude-haiku') */
  llmModel: string;
  /** Cost per 1K tokens for cloud LLMs (e.g., $0.002 for GPT-4o-mini) */
  llmCostPer1kTokens: number;
  /** Minimum profit ratio: bounty/costo must be >= this (default 1.5 = 50% profit) */
  minProfitRatio: number;
}

/**
 * Evaluation result for a work order
 */
export interface WorkOrderEvaluation {
  /** Whether the WO should be accepted */
  shouldAccept: boolean;
  /** Bounty amount in SYN */
  bountySyn: bigint;
  /** Bounty amount in USD */
  bountyUsd: number;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
  /** Profit ratio (bounty/cost) */
  profitRatio: number;
  /** Reason for decision */
  reason: string;
}

// Global state for the work order agent
let agentState: WorkOrderAgentState = {
  iteration: 0,
  totalWorkOrdersCompleted: 0,
  totalRewardsEarned: 0n,
  isRunning: false,
};

/**
 * Static price table for cloud LLM models
 * Prices in USD per 1K tokens (input+output average)
 */
const LLM_PRICE_TABLE: Record<string, number> = {
  // OpenAI models
  'gpt-4o': 0.005,
  'gpt-4o-mini': 0.00015,
  'gpt-4-turbo': 0.01,
  'gpt-3.5-turbo': 0.0005,
  
  // Anthropic models
  'claude-haiku': 0.00025,
  'claude-haiku-3': 0.00025,
  'claude-sonnet': 0.003,
  'claude-opus': 0.015,
  
  // Google models
  'gemini-flash': 0.000075,
  'gemini-pro': 0.00035,
  
  // Ollama models (local, $0 cost)
  'ollama/phi4-mini': 0,
  'ollama/llama3': 0,
  'ollama/mistral': 0,
};

/** Default fallback price (claude-haiku) when model not found */
const DEFAULT_MODEL_PRICE = 0.00025;

/**
 * Get cost per 1K tokens for a given LLM model
 * Falls back to DEFAULT_MODEL_PRICE with warning if model not found
 */
export function getModelCostPer1kTokens(model: string): number {
  // Check exact match
  if (model in LLM_PRICE_TABLE) {
    return LLM_PRICE_TABLE[model];
  }
  
  // Check for ollama/* pattern
  if (model.startsWith('ollama/')) {
    return 0;
  }
  
  // Log warning and fallback to haiku price
  console.warn(`[WorkOrderAgent] Unknown model "${model}" — falling back to claude-haiku pricing ($${DEFAULT_MODEL_PRICE}/1K tokens)`);
  return DEFAULT_MODEL_PRICE;
}

/**
 * Get current agent state
 */
export function getWorkOrderAgentState(): WorkOrderAgentState {
  return { ...agentState };
}

/**
 * Reset agent state
 */
export function resetWorkOrderAgentState(): void {
  agentState = {
    iteration: 0,
    totalWorkOrdersCompleted: 0,
    totalRewardsEarned: 0n,
    isRunning: false,
  };
}

/**
 * Fetch available work orders from coordinator
 */
export async function fetchAvailableWorkOrders(
  coordinatorUrl: string,
  peerId: string,
  capabilities: string[]
): Promise<WorkOrder[]> {
  try {
    const capabilitiesParam = capabilities.join(',');
    const url = `${coordinatorUrl}/work-orders/available?peerId=${peerId}&capabilities=${capabilitiesParam}`;

    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        // Endpoint not found - coordinator may not have work orders enabled
        return [];
      }
      throw new Error(`Failed to fetch work orders: ${response.statusText}`);
    }

    const data = await response.json() as WorkOrder[];
    return data || [];
  } catch (error) {
    console.warn('[WorkOrderAgent] Failed to fetch work orders:', (error as Error).message);
    return [];
  }
}

/**
 * Accept a work order
 */
export async function acceptWorkOrder(
  coordinatorUrl: string,
  workOrderId: string,
  peerId: string,
  nodeCapabilities: string[] = []
): Promise<boolean> {
  try {
    const response = await fetch(`${coordinatorUrl}/work-orders/${workOrderId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workOrderId,
        assigneeAddress: peerId,
        nodeCapabilities,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.warn(`[WorkOrderAgent] Failed to accept work order ${workOrderId}:`, error);
      return false;
    }

    return true;
  } catch (error) {
    console.warn('[WorkOrderAgent] Failed to accept work order:', (error as Error).message);
    return false;
  }
}

/**
 * Complete a work order with result
 */
export async function completeWorkOrder(
  coordinatorUrl: string,
  workOrderId: string,
  peerId: string,
  result: string,
  success: boolean = true
): Promise<boolean> {
  try {
    const response = await fetch(`${coordinatorUrl}/work-orders/${workOrderId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workOrderId,
        assigneeAddress: peerId,
        result,
        success,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.warn(`[WorkOrderAgent] Failed to complete work order ${workOrderId}:`, error);
      return false;
    }

    const data = await response.json() as WorkOrder;

    // Track rewards
    if (success && data.rewardAmount) {
      agentState.totalRewardsEarned += parseSynToLamports(data.rewardAmount);
    }

    return true;
  } catch (error) {
    console.warn('[WorkOrderAgent] Failed to complete work order:', (error as Error).message);
    return false;
  }
}

/**
 * Detect if work order is of type RESEARCH
 * Checks for RESEARCH type or parses description for research payload
 */
export function isResearchWorkOrder(workOrder: WorkOrder): boolean {
  if (workOrder.type === 'RESEARCH') return true;

  // Try to parse description as JSON with research payload
  try {
    const payload = JSON.parse(workOrder.description);
    return !!(payload.title && payload.abstract);
  } catch {
    return false;
  }
}

/**
 * Extract research payload from work order description
 */
export function extractResearchPayload(workOrder: WorkOrder): ResearchPayload | null {
  try {
    const payload = JSON.parse(workOrder.description);
    if (payload.title && payload.abstract) {
      return {
        title: payload.title,
        abstract: payload.abstract,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build research prompt for LLM
 */
export function buildResearchPrompt(payload: ResearchPayload): string {
  return `You are a research node in a decentralized AI network.
Analyze this paper and respond in JSON:
{
  "summary": "2-3 sentence summary",
  "keyInsights": ["insight1", ..., "insight5"],
  "proposal": "how this applies to decentralized compute"
}

Title: ${payload.title}
Abstract: ${payload.abstract}`;
}

/**
 * Execute research work order
 */
export async function executeResearchWorkOrder(
  workOrder: WorkOrder,
  llmModel: LLMModel,
  llmConfig?: LLMConfig
): Promise<{ result: ResearchResult; rawResponse: string; success: boolean }> {
  console.log(`[WorkOrderAgent] Executing research: ${workOrder.title}`);

  const payload = extractResearchPayload(workOrder);
  if (!payload) {
    throw new Error('Invalid research payload in work order');
  }

  const prompt = buildResearchPrompt(payload);
  const rawResponse = await generateLLM(llmModel, prompt, llmConfig);

  // Parse JSON response
  try {
    // Try to extract JSON from response (LLM may wrap it in markdown code fences)
    // 1. Strip ```json ... ``` or ``` ... ``` blocks
    // 2. Fall back to first {...} match
    let jsonStr = rawResponse;
    const fenceMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    } else {
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      jsonStr = jsonMatch ? jsonMatch[0] : rawResponse;
    }
    const result = JSON.parse(jsonStr) as ResearchResult;

    // Validate required fields
    if (!result.summary || !Array.isArray(result.keyInsights) || !result.proposal) {
      throw new Error('Invalid research result structure');
    }

    console.log(`[WorkOrderAgent] Research complete, summary: ${result.summary.slice(0, 100)}...`);
    return { result, rawResponse, success: true };
  } catch (error) {
    console.error('[WorkOrderAgent] Failed to parse research result:', (error as Error).message);
    return {
      result: {
        summary: 'Failed to parse LLM response',
        keyInsights: [],
        proposal: rawResponse.slice(0, 500),
      },
      rawResponse,
      success: false,
    };
  }
}

/**
 * Submit research result to coordinator
 */
export async function submitResearchResult(
  coordinatorUrl: string,
  workOrderId: string,
  peerId: string,
  result: ResearchResult
): Promise<boolean> {
  try {
    const response = await fetch(`${coordinatorUrl}/research-queue/results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workOrderId,
        peerId,
        summary: result.summary,
        keyInsights: result.keyInsights,
        proposal: result.proposal,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.warn(`[WorkOrderAgent] Failed to submit research result:`, error);
      return false;
    }

    console.log(`[WorkOrderAgent] Research result submitted successfully`);
    return true;
  } catch (error) {
    console.warn('[WorkOrderAgent] Failed to submit research result:', (error as Error).message);
    return false;
  }
}

/**
 * Save research result to agent brain journal
 */
export function saveResearchToBrain(
  brain: AgentBrain,
  workOrder: WorkOrder,
  result: ResearchResult
): void {
  const journalEntry = {
    timestamp: Date.now(),
    action: `research:${workOrder.id}`,
    outcome: 'completed',
    lesson: `Paper: ${workOrder.title}\nSummary: ${result.summary.slice(0, 200)}\nProposal: ${result.proposal.slice(0, 200)}`,
  };
  brain.journal.push(journalEntry);

  // Add to memory as discovery
  const memoryEntry = {
    timestamp: Date.now(),
    type: 'discovery' as const,
    content: `Research: ${result.summary}`,
    importance: 0.7,
  };
  brain.memory.push(memoryEntry);

  // Prune if needed
  if (brain.journal.length > 100) {
    brain.journal = brain.journal.slice(-100);
  }
  if (brain.memory.length > 100) {
    brain.memory = brain.memory.slice(-100);
  }
}

/**
 * Load economic configuration from environment or defaults
 * 
 * Priority for LLM cost:
 * 1. LLM_COST_PER_1K_TOKENS env var (manual override)
 * 2. Price table lookup by LLM_MODEL
 * 3. Default fallback (claude-haiku pricing)
 * 
 * @param runtimeModel - The actual model being used (from CLI config), takes
 *   precedence over the LLM_MODEL env var so cloud models are detected correctly.
 */
export function loadEconomicConfig(runtimeModel?: string): EconomicConfig {
  // runtimeModel (from CLI) wins over env var so cloud models aren't mistaken for ollama
  const llmModel = runtimeModel ?? process.env.LLM_MODEL ?? 'ollama/phi4-mini';

  // Derive llmType from the resolved model name rather than trusting a separate env var.
  // A model is considered local (ollama) only when it explicitly has the ollama/ prefix.
  // Everything else (gpt-*, claude-*, openai-compat/*, anthropic/*, etc.) is cloud.
  const isOllamaModel = llmModel.startsWith('ollama/');
  const llmType: 'ollama' | 'cloud' = isOllamaModel ? 'ollama' : 'cloud';
  
  // Get cost from price table or fallback
  let llmCostPer1kTokens: number;
  
  if (process.env.LLM_COST_PER_1K_TOKENS) {
    // Manual override takes priority
    llmCostPer1kTokens = parseFloat(process.env.LLM_COST_PER_1K_TOKENS);
  } else if (llmType === 'ollama') {
    // Ollama local models are always $0
    llmCostPer1kTokens = 0;
  } else {
    // Look up in price table with fallback
    llmCostPer1kTokens = getModelCostPer1kTokens(llmModel);
  }

  return {
    synPriceUsd: parseFloat(process.env.SYN_PRICE_USD ?? '0.01'),
    llmType,
    llmModel,
    llmCostPer1kTokens,
    minProfitRatio: parseFloat(process.env.MIN_PROFIT_RATIO ?? '1.5'),
  };
}

/**
 * Estimate LLM cost based on input text length
 * 
 * Rough estimation:
 * - Input tokens ≈ text.length / 4 (1 token ≈ 4 chars)
 * - Output tokens ≈ 500 (fixed for research responses)
 * 
 * Ollama (local) has $0 cost
 * Cloud models use configured price per 1K tokens
 */
export function estimateLLMCost(
  abstract: string,
  config: EconomicConfig
): number {
  // Ollama local models have no API cost
  if (config.llmType === 'ollama') {
    return 0;
  }

  // Estimate tokens (rough approximation)
  const inputTokens = Math.ceil(abstract.length / 4);
  const outputTokens = 500; // Fixed estimate for research responses
  const totalTokens = inputTokens + outputTokens;

  // Calculate cost
  const cost = (totalTokens / 1000) * config.llmCostPer1kTokens;
  return cost;
}

/**
 * Evaluate if a work order is economically viable
 * 
 * For RESEARCH work orders:
 * 1. Calculate bounty in USD (bountySyn * synPriceUsd)
 * 2. Estimate LLM cost based on abstract length
 * 3. If ratio < minProfitRatio → reject
 * 4. If llmType=ollama → always accept (cost is $0)
 * 
 * For other work orders → always accept (no compute cost tracked yet)
 */
export function evaluateWorkOrder(
  workOrder: WorkOrder,
  config: EconomicConfig
): WorkOrderEvaluation {
  const bountySyn = parseSynToLamports(workOrder.rewardAmount);
  const bountyUsd = Number(bountySyn) * config.synPriceUsd;

  // Non-research work orders: always accept (no compute cost tracking yet)
  if (!isResearchWorkOrder(workOrder)) {
    return {
      shouldAccept: true,
      bountySyn,
      bountyUsd,
      estimatedCostUsd: 0,
      profitRatio: Infinity,
      reason: 'Non-research WO: no compute cost estimation needed',
    };
  }

  // Extract abstract for cost estimation
  const payload = extractResearchPayload(workOrder);
  if (!payload) {
    return {
      shouldAccept: false,
      bountySyn,
      bountyUsd,
      estimatedCostUsd: 0,
      profitRatio: 0,
      reason: 'Invalid research payload',
    };
  }

  // Calculate cost
  const estimatedCostUsd = estimateLLMCost(payload.abstract, config);

  // Ollama (local) always accepts since cost is $0
  if (config.llmType === 'ollama') {
    return {
      shouldAccept: true,
      bountySyn,
      bountyUsd,
      estimatedCostUsd: 0,
      profitRatio: Infinity,
      reason: 'Local Ollama model: zero API cost, always accept',
    };
  }

  // Cloud models: check profit ratio
  if (estimatedCostUsd === 0) {
    return {
      shouldAccept: true,
      bountySyn,
      bountyUsd,
      estimatedCostUsd: 0,
      profitRatio: Infinity,
      reason: 'Zero cost estimate, accepting',
    };
  }

  const profitRatio = bountyUsd / estimatedCostUsd;
  const shouldAccept = profitRatio >= config.minProfitRatio;

  return {
    shouldAccept,
    bountySyn,
    bountyUsd,
    estimatedCostUsd,
    profitRatio,
    reason: shouldAccept
      ? `Profitable: ratio ${profitRatio.toFixed(2)}x >= ${config.minProfitRatio}x minimum`
      : `Not profitable: ratio ${profitRatio.toFixed(2)}x < ${config.minProfitRatio}x minimum`,
  };
}

/**
 * Execute a work order using LLM
 */
export async function executeWorkOrder(
  workOrder: WorkOrder,
  llmModel: LLMModel,
  llmConfig?: LLMConfig
): Promise<{ result: string; success: boolean }> {
  console.log(`[WorkOrderAgent] Executing: ${workOrder.title}`);

  try {
    // Check if this is a research work order
    if (isResearchWorkOrder(workOrder)) {
      const { result, rawResponse, success } = await executeResearchWorkOrder(
        workOrder,
        llmModel,
        llmConfig
      );
      return { result: rawResponse, success };
    }

    // Standard work order execution (TRAINING, INFERENCE, etc.)
    const prompt = buildWorkOrderPrompt(workOrder);
    const result = await generateLLM(llmModel, prompt, llmConfig);

    console.log(`[WorkOrderAgent] Execution complete, result length: ${result.length} chars`);

    return { result, success: true };
  } catch (error) {
    console.error('[WorkOrderAgent] Execution failed:', (error as Error).message);
    return {
      result: `Error: ${(error as Error).message}`,
      success: false
    };
  }
}

/**
 * Build prompt for work order execution
 */
function buildWorkOrderPrompt(workOrder: WorkOrder): string {
  return `You are a SynapseIA network node executing a work order.

Task: ${workOrder.title}
Description: ${workOrder.description}

Please provide a detailed response to complete this task. Be thorough and accurate.

Response:`;
}

/**
 * Run single iteration of the work order agent
 */
export async function runWorkOrderAgentIteration(
  config: WorkOrderAgentConfig,
  iteration: number,
  brain?: AgentBrain
): Promise<{ workOrder?: WorkOrder; completed: boolean; researchResult?: ResearchResult }> {
  const { coordinatorUrl, peerId, capabilities, llmModel, llmConfig } = config;

  console.log(`\n[WorkOrderAgent] Iteration ${iteration} starting...`);

  // 1. Fetch available work orders
  console.log('[WorkOrderAgent] Polling for available work orders...');
  const workOrders = await fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities);

  if (workOrders.length === 0) {
    console.log('[WorkOrderAgent] No work orders available');
    return { completed: false };
  }

  console.log(`[WorkOrderAgent] Found ${workOrders.length} available work order(s)`);

  // 2. Select best work order (first one - already sorted by reward)
  const workOrder = workOrders[0];
  console.log(`[WorkOrderAgent] Selected: "${workOrder.title}" (reward: ${workOrder.rewardAmount} SYN)`);

  // 2.5 Evaluate economic viability (rational node behavior)
  // Pass the runtime model so cloud models are detected correctly (not treated as Ollama)
  const economicConfig = loadEconomicConfig(config.llmModel?.modelId);
  const evaluation = evaluateWorkOrder(workOrder, economicConfig);

  console.log(`[WorkOrderAgent] Economic evaluation:`);
  console.log(`  - Bounty: ${evaluation.bountyUsd.toFixed(4)} USD (${workOrder.rewardAmount} SYN)`);
  console.log(`  - Est. cost: ${evaluation.estimatedCostUsd.toFixed(4)} USD`);
  console.log(`  - Profit ratio: ${evaluation.profitRatio === Infinity ? '∞' : evaluation.profitRatio.toFixed(2) + 'x'}`);
  console.log(`  - Decision: ${evaluation.shouldAccept ? 'ACCEPT' : 'SKIP'} (${evaluation.reason})`);

  if (!evaluation.shouldAccept) {
    console.log('[WorkOrderAgent] Skipping work order due to poor economics');
    return { completed: false, workOrder };
  }

  // 3. Accept work order
  console.log('[WorkOrderAgent] Accepting work order...');
  const accepted = await acceptWorkOrder(coordinatorUrl, workOrder.id, peerId, capabilities);

  if (!accepted) {
    console.log('[WorkOrderAgent] Failed to accept work order, skipping');
    return { completed: false };
  }

  console.log('[WorkOrderAgent] Work order accepted');
  agentState.currentWorkOrder = workOrder;

  // 4. Execute work order (handle RESEARCH specially)
  console.log('[WorkOrderAgent] Executing work order...');

  let result: string;
  let success: boolean;
  let researchResult: ResearchResult | undefined;

  if (isResearchWorkOrder(workOrder)) {
    // Execute research work order
    const research = await executeResearchWorkOrder(workOrder, llmModel, llmConfig);
    result = research.rawResponse;
    success = research.success;
    researchResult = research.result;

    // Save to agent brain if provided
    if (brain && success) {
      saveResearchToBrain(brain, workOrder, researchResult);
      console.log('[WorkOrderAgent] Research saved to agent brain');
    }

    // Submit to research queue endpoint
    if (success) {
      const submitted = await submitResearchResult(
        coordinatorUrl,
        workOrder.id,
        peerId,
        researchResult
      );
      if (submitted) {
        console.log('[WorkOrderAgent] Research result submitted to research queue');
      }
    }
  } else {
    // Standard work order execution (TRAINING, INFERENCE, etc.)
    const execution = await executeWorkOrder(workOrder, llmModel, llmConfig);
    result = execution.result;
    success = execution.success;
  }

  // 5. Complete work order
  console.log('[WorkOrderAgent] Reporting result...');
  const completed = await completeWorkOrder(
    coordinatorUrl,
    workOrder.id,
    peerId,
    result,
    success
  );

  if (completed) {
    console.log(`[WorkOrderAgent] Work order completed! Reward: ${workOrder.rewardAmount} SYN`);
    agentState.totalWorkOrdersCompleted++;
  } else {
    console.log('[WorkOrderAgent] Failed to report completion');
  }

  agentState.iteration = iteration;
  agentState.currentWorkOrder = undefined;

  return { workOrder, completed, researchResult };
}

/**
 * Start the work order agent loop
 */
export async function startWorkOrderAgent(config: WorkOrderAgentConfig): Promise<void> {
  if (agentState.isRunning) {
    throw new Error('Work order agent is already running');
  }

  agentState.isRunning = true;
  const { intervalMs, maxIterations } = config;

  console.log('🚀 Starting SynapseIA Work Order Agent');
  console.log(`   Coordinator: ${config.coordinatorUrl}`);
  console.log(`   Peer ID: ${config.peerId}`);
  console.log(`   Capabilities: ${config.capabilities.join(', ')}`);
  console.log(`   LLM: ${config.llmModel.modelId}`);
  console.log(`   Interval: ${intervalMs}ms`);
  if (maxIterations) {
    console.log(`   Max iterations: ${maxIterations}`);
  }
  console.log('');

  try {
    let iteration = 1;

    /* istanbul ignore next - async loop control, not business logic */
    while (shouldContinueLoop(agentState.isRunning, iteration, maxIterations)) {
      try {
        await runWorkOrderAgentIteration(config, iteration);
      } catch (error) {
        console.error(`[WorkOrderAgent] Iteration ${iteration} failed:`, (error as Error).message);
      }

      // Sleep before next iteration
      if (shouldSleepBetweenIterations(agentState.isRunning)) {
        console.log(`[WorkOrderAgent] Sleeping for ${intervalMs}ms...`);
        /* istanbul ignore next - async loop control, not business logic */
        await sleep(intervalMs);
      }

      iteration++;
    }

    if (maxIterations && iteration > maxIterations) {
      console.log(`\n[WorkOrderAgent] Reached max iterations (${maxIterations}), stopping.`);
    }
  } finally {
    agentState.isRunning = false;
    console.log('\n[WorkOrderAgent] Stopped');
  }
}

/**
 * Stop the work order agent
 */
export function stopWorkOrderAgent(): void {
  agentState.isRunning = false;
  console.log('[WorkOrderAgent] Stopping...');
}

/**
 * Check if the agent should stop due to reaching max iterations
 * Pure function for testability
 */
export function shouldStopForMaxIterations(
  iteration: number,
  maxIterations?: number,
): boolean {
  if (!maxIterations) return false;
  return iteration > maxIterations;
}

/**
 * Check if the loop should continue
 * Pure function for testability
 */
export function shouldContinueLoop(
  isRunning: boolean,
  iteration: number,
  maxIterations?: number,
): boolean {
  if (!isRunning) return false;
  if (maxIterations && iteration > maxIterations) return false;
  return true;
}

/**
 * Check if the agent should sleep between iterations
 * Pure function for testability
 */
export function shouldSleepBetweenIterations(isRunning: boolean): boolean {
  return isRunning;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Export for testing
export const _test = {
  fetchAvailableWorkOrders,
  acceptWorkOrder,
  completeWorkOrder,
  executeWorkOrder,
  runWorkOrderAgentIteration,
  sleep,
  shouldStopForMaxIterations,
  shouldContinueLoop,
  shouldSleepBetweenIterations,
  isResearchWorkOrder,
  extractResearchPayload,
  buildResearchPrompt,
  executeResearchWorkOrder,
  submitResearchResult,
  saveResearchToBrain,
  loadEconomicConfig,
  estimateLLMCost,
  evaluateWorkOrder,
  getModelCostPer1kTokens,
};
