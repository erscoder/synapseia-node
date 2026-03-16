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
}

export interface WorkOrderAgentState {
  iteration: number;
  totalWorkOrdersCompleted: number;
  totalRewardsEarned: bigint;
  isRunning: boolean;
  currentWorkOrder?: WorkOrder;
}

// Global state for the work order agent
let agentState: WorkOrderAgentState = {
  iteration: 0,
  totalWorkOrdersCompleted: 0,
  totalRewardsEarned: 0n,
  isRunning: false,
};

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
  peerId: string
): Promise<boolean> {
  try {
    const response = await fetch(`${coordinatorUrl}/work-orders/${workOrderId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workOrderId,
        assigneeAddress: peerId,
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
      agentState.totalRewardsEarned += BigInt(data.rewardAmount);
    }
    
    return true;
  } catch (error) {
    console.warn('[WorkOrderAgent] Failed to complete work order:', (error as Error).message);
    return false;
  }
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
    // Build prompt from work order
    const prompt = buildWorkOrderPrompt(workOrder);
    
    // Generate response using LLM
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
  iteration: number
): Promise<{ workOrder?: WorkOrder; completed: boolean }> {
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
  
  // 3. Accept work order
  console.log('[WorkOrderAgent] Accepting work order...');
  const accepted = await acceptWorkOrder(coordinatorUrl, workOrder.id, peerId);
  
  if (!accepted) {
    console.log('[WorkOrderAgent] Failed to accept work order, skipping');
    return { completed: false };
  }
  
  console.log('[WorkOrderAgent] Work order accepted');
  agentState.currentWorkOrder = workOrder;
  
  // 4. Execute work order
  console.log('[WorkOrderAgent] Executing work order...');
  const { result, success } = await executeWorkOrder(workOrder, llmModel, llmConfig);
  
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
  
  return { workOrder, completed };
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

    /* istanbul ignore next — async loop control, not business logic */
    while (shouldContinueLoop(agentState.isRunning, iteration, maxIterations)) {
      try {
        await runWorkOrderAgentIteration(config, iteration);
      } catch (error) {
        console.error(`[WorkOrderAgent] Iteration ${iteration} failed:`, (error as Error).message);
      }

      // Sleep before next iteration
      if (shouldSleepBetweenIterations(agentState.isRunning)) {
        console.log(`[WorkOrderAgent] Sleeping for ${intervalMs}ms...`);
        /* istanbul ignore next — async loop control, not business logic */
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
};
