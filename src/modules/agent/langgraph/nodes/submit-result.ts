import { Injectable } from '@nestjs/common';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import { FetchWorkOrdersNode } from './fetch-work-orders';
import { validateResearchResultJsonString } from '../../../../shared/node-side-submission-quality';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class SubmitResultNode {
  constructor(
    private readonly coordinator: WorkOrderCoordinatorHelper,
    private readonly fetchNode: FetchWorkOrdersNode,
    private readonly execution: WorkOrderExecutionHelper,
  ) {}


  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, executionResult, researchResult, coordinatorUrl, peerId, walletAddress } = state;
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
      // Bug 20 v3 (2026-05-18) — when a docking WO fails with a timeout
      // (obabel --gen3d in either tier OR vina), increment the per-WO
      // failure counter. After the cap (default 2), FetchWorkOrdersNode's
      // pre-fetch filter skips this WO on subsequent polls, avoiding the
      // observed 4-consecutive-failures pattern on
      // wo_docking_dp_5542e258-9c6_a_1779120600222_dbf771. Detection is
      // regex-based on the result string because `runDocking` wraps the
      // child-process error before bubbling. Non-timeout failures (Vina
      // exit non-zero, parse error) do NOT increment — they have
      // different root causes and shouldn't trigger the same skip.
      if (this.execution.isDockingWorkOrder(selectedWorkOrder)) {
        const resultStr = executionResult.result;
        const isTimeout = /timed out/i.test(resultStr);
        if (isTimeout) {
          // Disambiguate the timeout source for telemetry: obabel
          // `--gen3d` (med/fast/retry) vs Vina vs other obabel steps.
          // The error message embeds the binary name + flags via
          // `buildObabelTimeoutMessage`, so a substring scan suffices.
          const isObabelGen3d = /--gen3d/i.test(resultStr) || /gen3d/i.test(resultStr);
          const reason = isObabelGen3d ? 'obabel-gen3d-timeout' : 'docking-timeout';
          this.fetchNode.markFailedTimeout(selectedWorkOrder.id, reason);
        }
      }
      this.fetchNode.markCompleted(selectedWorkOrder);
      return { submitted: false };
    }

    // Bug 31 (2026-05-18) — client-side quality gate for RESEARCH WOs.
    // Mirrors the coord's `application/work-orders/submission-quality.ts`
    // contract so we reject obviously-malformed submissions locally and
    // save the POST + a coord-side `WOSubmit reject` log line. Observed
    // live 2026-05-18 on wo_1779113721582_cb5db91b: pod shipped a
    // 1-char `summary="{"`, coord rejected with
    // `hypothesis_too_short detail=1 chars < 30 min`.
    //
    // Belt-and-suspenders for the synthesizer-node empty-summary fix:
    // even if a future regression re-introduces the bare-`{` path or
    // any other unparseable-output path, this gate stops it before the
    // POST. Non-RESEARCH WOs (TRAINING/DOCKING/INFERENCE) ship
    // shape-incompatible payloads and are exempt from this check —
    // their quality is verified by the coord's domain-specific
    // validators (DockingSubmissionService, LoRA validation, etc.).
    if (this.execution.isResearchWorkOrder(selectedWorkOrder)) {
      const gate = validateResearchResultJsonString(executionResult.result);
      if (!gate.ok) {
        logger.warn(
          `[SubmitResult] Local quality gate rejected WO ${selectedWorkOrder.id} ` +
          `(reason=${gate.reason}, ${gate.detail}) — skipping POST`,
        );
        this.fetchNode.markCompleted(selectedWorkOrder);
        return { submitted: false };
      }
    }

    const completedIds = new Set<string>(state.completedWorkOrderIds ?? []);
    const updatedIds = [...completedIds];

    // Pre-submit status probe. The coordinator expires WOs on a cron and may
    // have reassigned this WO to another node. Posting a result for a WO that
    // is no longer ACCEPTED yields a 400 WORK_ORDER_NOT_ACCEPTABLE — drop the
    // result, arm the cooldown, and let the agent loop close cleanly.
    //
    // Coordinator's WorkOrderStatus enum: PENDING | ACCEPTED | COMPLETED |
    // VERIFIED | CANCELLED. Post-`acceptWorkOrder` the WO stays in `ACCEPTED`
    // until completion — that is the only state in which a submission is
    // valid. Any other status means the WO was completed by someone else,
    // already verified, or cancelled — drop. `probe === null` (404 from
    // coordinator) is treated as "still ours, proceed" so a transient coord
    // blip doesn't drop a legitimate result.
    const probe = await this.coordinator.getWorkOrder(coordinatorUrl, selectedWorkOrder.id);
    if (probe && probe.status !== 'ACCEPTED') {
      logger.info(`[Submit] dropping stale result for WO ${selectedWorkOrder.id} (status=${probe.status})`);
      this.fetchNode.markCompleted(selectedWorkOrder);
      updatedIds.push(selectedWorkOrder.id);
      return { submitted: true, completedWorkOrderIds: updatedIds };
    }

    logger.log(' Reporting result...');
    const completed = await this.coordinator.completeWorkOrder(
      coordinatorUrl, selectedWorkOrder.id, peerId, walletAddress,
      executionResult.result, executionResult.success,
      completedIds,
      (id: string) => updatedIds.push(id),
      () => {},
      (s: string) => BigInt(Math.floor(parseFloat(s) * 1e9)),
    );

    if (completed) {
      // Bug 34 (2026-05-18) — honest log. The previous form printed
      // `Potential reward: ${rewardAmount} SYN` which was the *round
      // pool* (e.g. 6000), not the per-peer payout. Actual settlement
      // splits 60/25/15 among top-3 (3600/1500/900 SYN) with 0 for
      // everyone else — the round-listener's post-settlement log is
      // the only honest source for what this peer earned. We keep
      // useful context (WO type, iteration) and drop the misleading
      // SYN amount entirely. P10 reviewer-lesson: no lying logs.
      const woType = selectedWorkOrder.type ?? 'UNKNOWN';
      logger.log(`[WO complete] id=${selectedWorkOrder.id} type=${woType} iter=${state.iteration} submitted=true`);
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
      const woType = selectedWorkOrder.type ?? 'UNKNOWN';
      logger.log(`[WO complete] id=${selectedWorkOrder.id} type=${woType} iter=${state.iteration} submitted=false`);
    }

    return { submitted: completed, completedWorkOrderIds: updatedIds };
  }
}
