/**
 * Bug Z1 — node iteratively re-trains + re-submits CANCELLED / closed-round
 * TRAINING work orders forever (zombie WO loop).
 *
 * Live evidence (2026-05-31): node-kike logged
 *   "Training complete" → "Reporting result..." →
 *   "[WO complete] id=wo_gpu_training_… type=GPU_TRAINING iter=N submitted=true"
 * for the SAME ids across iter=1,5,8,…,715,716, even though those WO rows
 * were CANCELLED in the coordinator DB and their rounds were CLOSED. The
 * node burned CPU forever and POSTed into closed rounds.
 *
 * Two confirmed root causes, both exercised here:
 *
 *   (a) SubmitResultNode fail-open on `probe === null`. `getWorkOrder`
 *       returns `null` for BOTH a 404 (WO purged after CANCEL) and any
 *       network error. The old code treated `null` as "still ours →
 *       POST", so a CANCELLED WO whose row 404s fell straight through to
 *       `completeWorkOrder`. A single transient blip must NOT nuke a
 *       legitimate in-flight result, so the fix treats `null` as terminal
 *       only after N CONSECUTIVE misses for a NON-RESEARCH WO.
 *
 *   (c) Even when the probe DID drop the submission, `markCompleted`
 *       only armed the 60s TRAINING cooldown — it never removed the WO
 *       from the permanent-exclusion set. After 60s the WO was selectable
 *       again and (re-surfaced via the gossipsub push queue, which floods
 *       TRAINING WOs) got re-iterated indefinitely. A TERMINAL drop
 *       (CANCELLED / closed-round / repeated 404) must be PERMANENT, not a
 *       cooldown. See the companion fetch-work-orders-zombie-wo.spec.ts for
 *       the re-selection half.
 *
 * RESEARCH cyclic re-offer (PENDING is submittable while the round is
 * OPEN) must stay intact — only COMPLETED/VERIFIED/CANCELLED drop it, and
 * a null probe for RESEARCH stays fail-open (the round-OPEN check is
 * server-side).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { SubmitResultNode } from '../submit-result';
import logger from '../../../../../utils/logger';
import type { WorkOrder } from '../../../work-order/work-order.types';

describe('SubmitResultNode — zombie WO loop (Bug Z1)', () => {
  let coordinator: {
    getWorkOrder: jest.Mock;
    completeWorkOrder: jest.Mock;
  };
  let fetchNode: {
    markCompleted: jest.Mock;
    markPermanentlyDropped: jest.Mock;
    markFailedTimeout: jest.Mock;
  };
  let node: SubmitResultNode;
  let infoSpy: jest.SpiedFunction<typeof logger.info>;
  let logSpy: jest.SpiedFunction<typeof logger.log>;
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;

  const trainingWO: WorkOrder = {
    id: 'wo_gpu_training_1780225274751_2817fe3f',
    title: 'GPU training round',
    description: 'd',
    requiredCapabilities: ['gpu_training'],
    rewardAmount: '6000',
    status: 'ACCEPTED',
    creatorAddress: 'creator',
    createdAt: 0,
    type: 'GPU_INFERENCE',
  };

  const baseState = {
    selectedWorkOrder: trainingWO,
    executionResult: { success: true, result: 'valLoss=0.42 improved=true' },
    coordinatorUrl: 'http://coord',
    peerId: 'peer-1',
    walletAddress: 'wallet-1',
    completedWorkOrderIds: [],
    iteration: 715,
  } as any;

  beforeEach(() => {
    coordinator = {
      getWorkOrder: jest.fn(),
      completeWorkOrder: jest.fn(),
    };
    fetchNode = {
      markCompleted: jest.fn(),
      markPermanentlyDropped: jest.fn(),
      markFailedTimeout: jest.fn(),
    };
    const execution = {
      isResearchWorkOrder: jest.fn().mockReturnValue(false),
      isDockingWorkOrder: jest.fn().mockReturnValue(false),
    };
    node = new SubmitResultNode(coordinator as any, fetchNode as any, execution as any);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  describe('CANCELLED non-research WO is dropped PERMANENTLY (not re-iterated)', () => {
    it('does NOT POST and marks the WO permanently-dropped when probe is CANCELLED', async () => {
      coordinator.getWorkOrder.mockResolvedValue({ ...trainingWO, status: 'CANCELLED' });

      const out = await node.execute(baseState);

      expect(coordinator.completeWorkOrder).not.toHaveBeenCalled();
      // Permanent drop — NOT the 60s cooldown via markCompleted. This is
      // what stops the iter=715,716 re-training loop.
      expect(fetchNode.markPermanentlyDropped).toHaveBeenCalledWith(trainingWO);
      expect(out.submitted).toBe(true);
      expect(out.completedWorkOrderIds).toContain(trainingWO.id);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining(`dropping stale result for WO ${trainingWO.id} (status=CANCELLED)`),
      );
    });
  });

  describe('null probe (404 / network) for a NON-RESEARCH WO — transient-blip guard', () => {
    it('first null probe stays fail-open: still POSTs (single blip must not nuke a result)', async () => {
      coordinator.getWorkOrder.mockResolvedValue(null);
      coordinator.completeWorkOrder.mockResolvedValue(true);

      const out = await node.execute(baseState);

      expect(coordinator.completeWorkOrder).toHaveBeenCalledTimes(1);
      expect(fetchNode.markPermanentlyDropped).not.toHaveBeenCalled();
      expect(out.submitted).toBe(true);
    });

    it('Nth consecutive null probe is treated as terminal: drops + permanently-dropped, no POST', async () => {
      coordinator.getWorkOrder.mockResolvedValue(null);

      // Drive the consecutive-miss counter past the cap. The default cap is
      // 2 misses, so the 2nd consecutive null on the SAME id must drop.
      await node.execute(baseState); // miss #1 → fail-open POST (mocked below not needed; completeWorkOrder undefined → handled)
      coordinator.completeWorkOrder.mockResolvedValue(true);
      coordinator.completeWorkOrder.mockClear();

      const out = await node.execute(baseState); // miss #2 → terminal

      expect(coordinator.completeWorkOrder).not.toHaveBeenCalled();
      expect(fetchNode.markPermanentlyDropped).toHaveBeenCalledWith(trainingWO);
      expect(out.submitted).toBe(true);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining(`dropping stale result for WO ${trainingWO.id}`),
      );
    });

    it('a successful probe between nulls RESETS the consecutive-miss counter', async () => {
      // null, null would normally hit the cap; an ACCEPTED probe in the
      // middle resets the streak so the trailing null stays fail-open.
      coordinator.getWorkOrder
        .mockResolvedValueOnce(null) // miss #1
        .mockResolvedValueOnce({ ...trainingWO, status: 'ACCEPTED' }) // reset
        .mockResolvedValueOnce(null); // miss #1 again (NOT #3)
      coordinator.completeWorkOrder.mockResolvedValue(true);

      await node.execute(baseState); // fail-open POST
      await node.execute(baseState); // ACCEPTED → POST
      coordinator.completeWorkOrder.mockClear();
      const out = await node.execute(baseState); // single miss after reset → fail-open POST

      expect(coordinator.completeWorkOrder).toHaveBeenCalledTimes(1);
      expect(fetchNode.markPermanentlyDropped).not.toHaveBeenCalled();
      expect(out.submitted).toBe(true);
    });
  });

  describe('nullProbeStreak map is bounded — cleared on success and on reset() (Bug Z1 leak fix)', () => {
    it('a successful POST clears the consecutive-null-probe counter for that id', async () => {
      // miss #1 (fail-open POST) arms streak=1; then an ACCEPTED probe path
      // POSTs successfully. The success MUST delete the streak entry, so a
      // LATER single null counts as miss #1 again (fail-open), not miss #2.
      coordinator.completeWorkOrder.mockResolvedValue(true);
      coordinator.getWorkOrder
        .mockResolvedValueOnce(null) // miss #1 → fail-open POST → success clears streak
        .mockResolvedValueOnce(null); // single miss AFTER clear → still fail-open

      await node.execute(baseState); // miss #1 + successful POST → streak cleared
      coordinator.completeWorkOrder.mockClear();
      const out = await node.execute(baseState); // would be miss #2 if NOT cleared → terminal

      // Cleared on success → this is miss #1 → fail-open POST, NOT a terminal drop.
      expect(coordinator.completeWorkOrder).toHaveBeenCalledTimes(1);
      expect(fetchNode.markPermanentlyDropped).not.toHaveBeenCalled();
      expect(out.submitted).toBe(true);
    });

    it('reset() clears the consecutive-null-probe counter', async () => {
      // miss #1 arms streak=1 (no successful POST this time — completeWorkOrder
      // returns false so the success-path clear does NOT fire and the entry
      // survives the first execute).
      coordinator.completeWorkOrder.mockResolvedValue(false);
      coordinator.getWorkOrder.mockResolvedValue(null);

      await node.execute(baseState); // miss #1 → fail-open POST (returns false) → streak=1 retained

      // Without reset, the next null would be miss #2 → terminal drop. reset()
      // wipes the map, so the next null is miss #1 again → fail-open.
      node.reset();

      coordinator.completeWorkOrder.mockClear();
      coordinator.completeWorkOrder.mockResolvedValue(true);
      const out = await node.execute(baseState); // miss #1 after reset → fail-open POST

      expect(coordinator.completeWorkOrder).toHaveBeenCalledTimes(1);
      expect(fetchNode.markPermanentlyDropped).not.toHaveBeenCalled();
      expect(out.submitted).toBe(true);
    });
  });

  describe('RESEARCH null probe stays fail-open regardless of streak (round-OPEN check is server-side)', () => {
    it('does NOT escalate consecutive RESEARCH nulls to a terminal drop', async () => {
      const researchWO: WorkOrder = { ...trainingWO, id: 'wo_research_z', type: 'RESEARCH' };
      const researchResultJson = JSON.stringify({
        hypothesis: 'Distributed gradient averaging converges under heterogeneous batch sizes.',
        keyInsights: ['loss decreased monotonically across all peers'],
      });
      const researchState = {
        ...baseState,
        selectedWorkOrder: researchWO,
        executionResult: { success: true, result: researchResultJson },
      };
      coordinator.getWorkOrder.mockResolvedValue(null);
      coordinator.completeWorkOrder.mockResolvedValue(true);

      await node.execute(researchState);
      coordinator.completeWorkOrder.mockClear();
      const out = await node.execute(researchState); // 2nd null — RESEARCH stays fail-open

      expect(coordinator.completeWorkOrder).toHaveBeenCalledTimes(1);
      expect(fetchNode.markPermanentlyDropped).not.toHaveBeenCalled();
      expect(out.submitted).toBe(true);
    });
  });
});
