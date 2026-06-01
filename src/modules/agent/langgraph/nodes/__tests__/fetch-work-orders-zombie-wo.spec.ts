/**
 * Bug Z1 (re-selection half) — a TRAINING / DiLoCo WO that SubmitResultNode
 * dropped as TERMINAL (CANCELLED / closed-round / repeated 404) must be
 * removed from the iteration/active set PERMANENTLY, so the next discovery
 * tick does NOT re-select it.
 *
 * Pre-fix the pending filter (fetch-work-orders.ts) only consulted
 * `trainingCooldowns` for TRAINING/DiLoCo WOs — it NEVER consulted the
 * permanent-exclusion set. So `markCompleted` (60s cooldown) was the only
 * lever a TRAINING WO ever got, and after 60s the gossipsub-pushed WO was
 * selectable again → re-trained forever (iter=715,716 in prod logs).
 *
 * Fix: `markPermanentlyDropped(wo)` adds the id to the permanent set, AND
 * the TRAINING/DiLoCo branch of the pending filter now drops a
 * permanently-excluded WO BEFORE the cooldown check.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { FetchWorkOrdersNode } from '../fetch-work-orders';
import type { WorkOrder } from '../../../work-order/work-order.types';
import logger from '../../../../../utils/logger';
import {
  __seedCapabilitySnapshotForTests,
  __resetCapabilitySnapshotForTests,
} from '../../../../heartbeat/heartbeat';

describe('FetchWorkOrdersNode — permanently-dropped TRAINING WO is not re-selected (Bug Z1)', () => {
  let coordinator: { fetchAvailableWorkOrders: jest.Mock };
  let execution: {
    isResearchWorkOrder: jest.Mock;
    isTrainingWorkOrder: jest.Mock;
    isDiLoCoWorkOrder: jest.Mock;
  };
  let backpressure: {
    canAccept: jest.Mock;
    getInFlightByClass: jest.Mock;
    getMaxByClass: jest.Mock;
    isDraining: jest.Mock;
  };
  let pushQueue: { drain: jest.Mock; size: jest.Mock };
  let node: FetchWorkOrdersNode;
  let logSpy: jest.SpiedFunction<typeof logger.log>;
  let infoSpy: jest.SpiedFunction<typeof logger.info>;

  // TRAINING → cpu_training (wo-type-to-cap.ts:51). The required cap and
  // seeded live caps must match that mapping or canLocallyAcceptWorkOrder
  // rejects the WO before the cooldown/permanent-drop logic is even reached.
  const gpuTrainingWO: WorkOrder = {
    id: 'wo_gpu_training_1780225274751_2817fe3f',
    title: 'GPU training round',
    description: 'd',
    requiredCapabilities: ['cpu_training'],
    rewardAmount: '6000',
    status: 'AVAILABLE',
    creatorAddress: 'creator',
    createdAt: 0,
    type: 'TRAINING',
  };

  const baseState = {
    coordinatorUrl: 'http://coord',
    peerId: 'peer-1',
    capabilities: ['cpu_training'],
    rejectedWorkOrderIds: [],
  } as any;

  beforeEach(() => {
    coordinator = { fetchAvailableWorkOrders: jest.fn() };
    execution = {
      isResearchWorkOrder: jest.fn().mockReturnValue(false),
      isTrainingWorkOrder: jest.fn().mockReturnValue(true),
      isDiLoCoWorkOrder: jest.fn().mockReturnValue(false),
    };
    backpressure = {
      canAccept: jest.fn().mockReturnValue(true),
      getInFlightByClass: jest.fn().mockReturnValue(0),
      getMaxByClass: jest.fn().mockImplementation((cls: string) => (cls === 'HEAVY' ? 1 : 2)),
      isDraining: jest.fn().mockReturnValue(false),
    };
    pushQueue = { drain: jest.fn().mockReturnValue([]), size: jest.fn().mockReturnValue(0) };
    node = new FetchWorkOrdersNode(
      coordinator as any,
      execution as any,
      backpressure as any,
      pushQueue as any,
    );
    logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    __seedCapabilitySnapshotForTests(['cpu_training']);
  });

  afterEach(() => {
    __resetCapabilitySnapshotForTests();
    logSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('re-surfaces a TRAINING WO that was only cooldowned (control — cooldown is NOT permanent)', async () => {
    // Sanity that the WO is selectable when nothing excludes it.
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([gpuTrainingWO]);

    const out = await node.execute(baseState);

    expect(out.availableWorkOrders).toEqual([gpuTrainingWO]);
  });

  it('does NOT re-select a TRAINING WO after markPermanentlyDropped (Bug Z1 repro)', async () => {
    // Simulate SubmitResultNode terminal-dropping the CANCELLED WO.
    node.markPermanentlyDropped(gpuTrainingWO);

    // Coord still re-offers it (e.g. via gossipsub push flood) on the next tick.
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([gpuTrainingWO]);

    const out = await node.execute(baseState);

    // Pre-fix the TRAINING branch ignored the permanent set → WO survived
    // the filter → re-iterated forever. Now it must be dropped.
    expect(out.availableWorkOrders).toEqual([]);
  });

  it('a 60s cooldown alone (markCompleted) still allows re-selection once the cooldown lapses', async () => {
    // markCompleted on a TRAINING WO only arms the 60s cooldown; it is NOT
    // a permanent exclusion. With env TRAINING_COOLDOWN_MS at default 60s,
    // a WO marked completed is still in cooldown the same tick → filtered.
    node.markCompleted(gpuTrainingWO);
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([gpuTrainingWO]);

    const out = await node.execute(baseState);

    // Within the cooldown window the WO is filtered (cooldown path), but it
    // is NOT in the permanent set — proving markCompleted is the wrong lever
    // for a terminal WO. (This documents the distinction; the permanent fix
    // is the previous test.)
    expect(out.availableWorkOrders).toEqual([]);
  });

  /**
   * Bug Z1 (HIGH, P42/P6) — the RESEARCH branch of the pending filter returns
   * FIRST, so the generic `!completedWorkOrderIds.has(wo.id)` at the bottom is
   * unreachable for research. Without the permanent-set guard at the TOP of
   * the research branch, a RESEARCH WO that SubmitResultNode terminal-dropped
   * (markPermanentlyDropped, e.g. probe CANCELLED) was re-selected on the next
   * tick → same zombie loop, for research. The guard mirrors the TRAINING fix.
   *
   * RESEARCH cyclic re-offer stays intact: a research WO that was NEVER
   * permanently dropped (PENDING in an OPEN round) is still selectable — only
   * a markPermanentlyDropped'd one is excluded.
   */
  describe('permanently-dropped RESEARCH WO is not re-selected', () => {
    // RESEARCH → any of ['inference','llm'] (wo-type-to-cap.ts:49), and the
    // WO's requiredCapabilities are intersected against caps too — so the
    // required cap and the seeded live caps must both be `inference` for the
    // WO to clear canLocallyAcceptWorkOrder and reach the research branch.
    const researchWO: WorkOrder = {
      ...gpuTrainingWO,
      id: 'wo_research_1780225274751_aa11bb22',
      title: 'Research paper analysis',
      requiredCapabilities: ['inference'],
      type: 'RESEARCH',
    };

    beforeEach(() => {
      // Re-wire the type classifiers so THIS WO takes the research branch.
      execution.isResearchWorkOrder.mockReturnValue(true);
      execution.isTrainingWorkOrder.mockReturnValue(false);
      execution.isDiLoCoWorkOrder.mockReturnValue(false);
      // Seed live caps to satisfy both the RESEARCH OR-mapping and the
      // requiredCapabilities subset so the gate passes and the branch is reached.
      __resetCapabilitySnapshotForTests();
      __seedCapabilitySnapshotForTests(['inference']);
    });

    it('control — a NOT-dropped research WO IS selectable (cyclic re-offer intact)', async () => {
      coordinator.fetchAvailableWorkOrders.mockResolvedValue([researchWO]);

      const out = await node.execute({ ...baseState, capabilities: ['inference'] });

      expect(out.availableWorkOrders).toEqual([researchWO]);
    });

    it('does NOT re-select a RESEARCH WO after markPermanentlyDropped (Bug Z1 repro)', async () => {
      // Simulate SubmitResultNode terminal-dropping the CANCELLED research WO.
      node.markPermanentlyDropped(researchWO);

      // Coord still re-offers it (cyclic re-offer / gossipsub) on the next tick.
      coordinator.fetchAvailableWorkOrders.mockResolvedValue([researchWO]);

      const out = await node.execute({ ...baseState, capabilities: ['inference'] });

      // Pre-guard the research branch ignored the permanent set and returned
      // `true` after the cooldown check → WO survived the filter → re-iterated
      // forever. With the guard it must be dropped.
      expect(out.availableWorkOrders).toEqual([]);
    });
  });
});
