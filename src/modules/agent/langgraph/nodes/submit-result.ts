import { Injectable } from '@nestjs/common';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { FetchWorkOrdersNode } from './fetch-work-orders';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class SubmitResultNode {
  constructor(
    private readonly coordinator: WorkOrderCoordinatorHelper,
    private readonly fetchNode: FetchWorkOrdersNode,
  ) {}


  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, executionResult, researchResult, coordinatorUrl, peerId } = state;
    if (!selectedWorkOrder || !executionResult) return { submitted: false };

    // Hard guard: never ship a failed execution. QualityGateNode is supposed
    // to route around this via `shouldSubmit: false`, but a belt-and-suspenders
    // check here protects against graph-edge regressions AND any legacy path
    // that might invoke this node directly. Also arms the cooldown so the
    // node doesn't hot-loop on the same broken WO.
    if (executionResult.success === false) {
      logger.warn(
        ` Skipping submission: execution failed for WO ${selectedWorkOrder.id} — ` +
        `${executionResult.result.slice(0, 120)}`,
      );
      this.fetchNode.markCompleted(selectedWorkOrder);
      return { submitted: false };
    }

    const completedIds = new Set<string>(state.completedWorkOrderIds ?? []);
    const updatedIds = [...completedIds];

    // Bug H1: pre-submit status probe. The coordinator expires WOs on a
    // cron and may have reassigned this WO to another node. Posting a
    // result for a WO that is no longer ASSIGNED/IN_PROGRESS yields a
    // 400 WORK_ORDER_NOT_ACCEPTABLE — drop the result, arm the cooldown,
    // and let the agent loop close cleanly without a retry.
    //
    // Drop states (anything ≠ ASSIGNED/IN_PROGRESS): PENDING (not yet
    // claimed by anyone — should not happen for a WO this node was
    // about to submit, but treat as stale), COMPLETED (already
    // submitted by us or another node), FAILED (terminal cron-expired
    // or coordinator-rejected). The brief writes the gate as
    // `status !== 'ACCEPTED'`; the WorkOrder type has no `'ACCEPTED'`
    // literal — the active states post-`acceptWorkOrder` are
    // `ASSIGNED` then `IN_PROGRESS`, and we keep submitting while in
    // either of those. `probe === null` (404 from coordinator) is
    // treated as "still ours, proceed" so a transient coord blip
    // doesn't drop a legitimate result.
    const probe = await this.coordinator.getWorkOrder(coordinatorUrl, selectedWorkOrder.id);
    if (probe && probe.status !== 'ASSIGNED' && probe.status !== 'IN_PROGRESS') {
      logger.info(`[Submit] dropping stale result for WO ${selectedWorkOrder.id} (status=${probe.status})`);
      this.fetchNode.markCompleted(selectedWorkOrder);
      updatedIds.push(selectedWorkOrder.id);
      return { submitted: true, completedWorkOrderIds: updatedIds };
    }

    logger.log(' Reporting result...');
    const completed = await this.coordinator.completeWorkOrder(
      coordinatorUrl, selectedWorkOrder.id, peerId,
      executionResult.result, executionResult.success,
      completedIds,
      (id: string) => updatedIds.push(id),
      () => {},
      (s: string) => BigInt(Math.floor(parseFloat(s) * 1e9)),
    );

    if (completed) {
      logger.log(` Result submitted! Potential reward: ${selectedWorkOrder.rewardAmount} SYN`);
      // Arm per-WO cooldowns so the next poll doesn't immediately re-accept
      // the same WO. markCompleted branches by type (RESEARCH long cooldown,
      // TRAINING short cooldown, everything else permanent). Without this
      // call the cooldowns declared in FetchWorkOrdersNode were effectively
      // dead code in the langgraph flow — node submitted + re-accepted the
      // same WO within 30s, flooding the coordinator with redundant
      // submissions for the same research paper.
      this.fetchNode.markCompleted(selectedWorkOrder);
      // Research results are registered in the ResearchRound via completeWorkOrder().
      // The coordinator extracts summary/insights/proposal from the result JSON automatically.
      void researchResult; // kept in state for brain/memory
    } else {
      logger.log(' Failed to report completion');
    }

    return { submitted: completed, completedWorkOrderIds: updatedIds };
  }
}
