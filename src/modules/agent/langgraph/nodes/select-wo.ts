import { Injectable } from '@nestjs/common';
import type { AgentState } from '../state';

@Injectable()
export class SelectWorkOrderNode {
  execute(state: AgentState): Partial<AgentState> {
    const { availableWorkOrders } = state;
    if (!availableWorkOrders.length) {
      return { selectedWorkOrder: null };
    }
    // Take first available — Sprint B will add LLM-based selection
    return { selectedWorkOrder: availableWorkOrders[0] };
  }
}
