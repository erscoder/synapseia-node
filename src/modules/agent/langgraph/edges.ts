/**
 * Conditional Edges for LangGraph Agent
 * Sprint A - LangGraph Foundation
 * 
 * Defines the routing logic between nodes based on state
 */

import type { AgentState } from './state.js';

/**
 * Edge: hasWorkOrders
 * Routes to SELECT_BEST_WO if work orders are available, otherwise END
 */
export function hasWorkOrders(state: AgentState): 'selectBestWorkOrder' | '__end__' {
  return state.availableWorkOrders.length > 0 ? 'selectBestWorkOrder' : '__end__';
}

/**
 * Edge: shouldAccept
 * Routes to ACCEPT_WO if economics evaluation says accept, otherwise back to select
 */
export function shouldAccept(state: AgentState): 'acceptWorkOrder' | 'fetchWorkOrders' {
  if (!state.economicEvaluation) {
    return 'fetchWorkOrders';
  }
  return state.economicEvaluation.shouldAccept ? 'acceptWorkOrder' : 'fetchWorkOrders';
}

/**
 * Edge: routeByType
 * Routes to the correct executor based on work order type
 */
export function routeByType(state: AgentState): 
  | 'executeResearch'
  | 'executeTraining'
  | 'executeInference'
  | 'executeDiloco'
  | 'executeDefault' {
  
  if (!state.selectedWorkOrder) {
    return 'executeDefault';
  }

  const workOrder = state.selectedWorkOrder;
  const type = workOrder.type;

  switch (type) {
    case 'RESEARCH':
      return 'executeResearch';
    case 'TRAINING':
      return 'executeTraining';
    case 'CPU_INFERENCE':
      return 'executeInference';
    case 'DILOCO_TRAINING':
      return 'executeDiloco';
    default:
      return 'executeDefault';
  }
}

/**
 * Edge: shouldSubmitResult
 * Routes to SUBMIT_RESULT if quality gate passes, otherwise to updateMemory
 */
export function shouldSubmitResult(state: AgentState): 'submitResult' | 'updateMemory' {
  return state.shouldSubmit ? 'submitResult' : 'updateMemory';
}

/**
 * Edge: afterExecution
 * Routes to QUALITY_GATE after any execution
 */
export function afterExecution(state: AgentState): 'qualityGate' {
  return 'qualityGate';
}

/**
 * Edge: afterAccept
 * Routes to ROUTE_BY_TYPE after accepting work order
 */
export function afterAccept(state: AgentState): 'routeByType' {
  return 'routeByType';
}
