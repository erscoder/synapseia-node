import { Injectable } from '@nestjs/common';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

/**
 * LangGraph fail-loud sink for unknown `WorkOrderType` values.
 *
 * The router previously fell back to `executeTraining` for any
 * unrecognised type, which crashed mutation-engine for
 * docking/lora payloads. Now the router routes here, qualityGate
 * sees `success=false`, the WO is left in ACCEPTED and the coord
 * re-assigns. Compile-time exhaustiveness (`never` guard in the
 * router) prevents future regressions; this runtime sink covers
 * the cases where the type string somehow reaches us as something
 * outside the union (e.g. coord ships a new type before the node
 * code is updated).
 */
@Injectable()
export class UnknownTypeNode {
  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const wo = state.selectedWorkOrder;
    if (!wo) {
      return { executionResult: { result: 'No work order selected', success: false } };
    }

    logger.warn(
      ` unknown WO type=${String(wo.type)} id=${wo.id} — refusing to execute, will be reassigned`,
    );
    return { executionResult: { result: 'unknown WO type', success: false } };
  }
}
