/**
 * D-P2P additive discovery + per-type fairness (2026-05-31).
 *
 * REGRESSION FIXED: WO discovery was MUTUALLY EXCLUSIVE per tick — a
 * non-empty gossipsub push queue (TRAINING floods it every minute) short-
 * circuited the HTTP poll forever, so poll-only types (RESEARCH,
 * *_INFERENCE) were never discovered and inference submissions went to 0
 * network-wide. This suite proves:
 *   1. push + poll MERGE (RESEARCH from poll surfaces even with a non-empty
 *      TRAINING push queue, once the poll cadence is due).
 *   2. dedup: a WO present in BOTH sources is not double-listed.
 *   3. fairness: least-recently-done type bubbles to index 0; single
 *      available type is still taken (no idle); an incapable type is
 *      never surfaced.
 *   4. the windowed counter decays (is NOT lifetime).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { FetchWorkOrdersNode } from '../fetch-work-orders';
import type { PushedWorkOrder } from '../../../work-order/work-order-push-queue';
import type { WorkOrder } from '../../../work-order/work-order.types';
import logger from '../../../../../utils/logger';
import {
  __seedCapabilitySnapshotForTests,
  __resetCapabilitySnapshotForTests,
} from '../../../../heartbeat/heartbeat';
import { __resetDiscoverySourceCounterForTests } from '../../../../telemetry';
import {
  WoTypeRecentCounts,
  __resetWoTypeRecentCountsForTests,
} from '../../../../../shared/wo-type-recent-counts';

describe('FetchWorkOrdersNode — D-P2P additive discovery + fairness', () => {
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
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;
  let infoSpy: jest.SpiedFunction<typeof logger.info>;

  const trainingPushed: PushedWorkOrder = {
    id: 'wo-train-1',
    title: 'Pushed TRAINING',
    description: 'desc',
    type: 'TRAINING',
    status: 'AVAILABLE',
    rewardAmount: '5000',
    requiredCapabilities: ['cpu_training'],
    creatorAddress: 'creator-train',
    createdAt: 1716800000000,
    receivedAt: Date.now(),
  };

  const researchHttp: WorkOrder = {
    id: 'wo-research-1',
    title: 'HTTP RESEARCH',
    description: 'paper',
    requiredCapabilities: ['inference'],
    rewardAmount: '999',
    status: 'PENDING',
    creatorAddress: 'creator-research',
    createdAt: 0,
    type: 'RESEARCH',
  };

  const baseState = {
    coordinatorUrl: 'http://coord',
    peerId: 'peer-1',
    capabilities: ['cpu_training', 'inference'],
    rejectedWorkOrderIds: [],
  } as any;

  /** Drive enough gossipsub-hit ticks to consume the resync cadence so the
   * NEXT tick is forced to HTTP-poll despite a non-empty push queue. */
  const FULL_RESYNC_EVERY_N_POLLS = 12;

  beforeEach(() => {
    coordinator = { fetchAvailableWorkOrders: jest.fn() };
    execution = {
      isResearchWorkOrder: jest.fn().mockImplementation((wo: any) => wo.type === 'RESEARCH'),
      isTrainingWorkOrder: jest.fn().mockImplementation((wo: any) => wo.type === 'TRAINING'),
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
    node.__resetResyncStateForTests();
    node.__setRecentCountsForTests(new WoTypeRecentCounts(60_000));
    __seedCapabilitySnapshotForTests(['cpu_training', 'inference']);
    __resetDiscoverySourceCounterForTests();
    __resetWoTypeRecentCountsForTests();
    logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    delete process.env.SYNAPSEIA_DISABLE_WO_POLL;
  });

  afterEach(() => {
    __resetCapabilitySnapshotForTests();
    __resetDiscoverySourceCounterForTests();
    __resetWoTypeRecentCountsForTests();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('MERGE: non-empty TRAINING push queue + cadence-due → RESEARCH from poll is discovered (the regression)', async () => {
    pushQueue.drain.mockReturnValue([trainingPushed]);
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([researchHttp]);
    // Force the poll cadence so this tick polls even with a non-empty queue.
    (node as any).pollsSinceFullResync = FULL_RESYNC_EVERY_N_POLLS;

    const out = await node.execute(baseState);

    expect(coordinator.fetchAvailableWorkOrders).toHaveBeenCalledTimes(1);
    const ids = (out.availableWorkOrders ?? []).map((wo) => wo.id);
    expect(ids).toContain('wo-train-1');
    expect(ids).toContain('wo-research-1');
  });

  it('DEDUP: same WO id in BOTH push and poll appears exactly once (push copy wins, no double-process)', async () => {
    const dupPushed: PushedWorkOrder = { ...trainingPushed, id: 'dup-1', title: 'PUSH copy' };
    const dupPoll: WorkOrder = {
      ...researchHttp,
      id: 'dup-1',
      title: 'POLL copy',
      type: 'TRAINING',
      requiredCapabilities: ['cpu_training'],
    };
    pushQueue.drain.mockReturnValue([dupPushed]);
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([dupPoll]);
    (node as any).pollsSinceFullResync = FULL_RESYNC_EVERY_N_POLLS;

    const out = await node.execute(baseState);

    const matches = (out.availableWorkOrders ?? []).filter((wo) => wo.id === 'dup-1');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.title).toBe('PUSH copy'); // push wins
  });

  it('CADENCE: with the push queue perpetually non-empty, the poll fires periodically (not never)', async () => {
    pushQueue.drain.mockReturnValue([trainingPushed]);
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([]);

    // First N ticks: push-hit only, no poll (cadence not yet due).
    for (let i = 0; i < FULL_RESYNC_EVERY_N_POLLS; i++) {
      await node.execute(baseState);
    }
    expect(coordinator.fetchAvailableWorkOrders).not.toHaveBeenCalled();

    // Tick N+1: cadence due → poll fires despite the non-empty push queue.
    await node.execute(baseState);
    expect(coordinator.fetchAvailableWorkOrders).toHaveBeenCalledTimes(1);
  });

  it('FAIRNESS: least-recently-done type bubbles to index 0 (SelectWorkOrder takes [0])', async () => {
    // Record many recent TRAINING completions → TRAINING is "recently done".
    const counts = new WoTypeRecentCounts(60_000);
    for (let i = 0; i < 5; i++) counts.record('TRAINING');
    node.__setRecentCountsForTests(counts);

    // Candidate set has BOTH a TRAINING (pushed) and a RESEARCH (poll).
    pushQueue.drain.mockReturnValue([trainingPushed]);
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([researchHttp]);
    (node as any).pollsSinceFullResync = FULL_RESYNC_EVERY_N_POLLS;

    const out = await node.execute(baseState);

    // RESEARCH (count 0) must precede TRAINING (count 5) → index 0.
    expect(out.availableWorkOrders?.[0]?.type).toBe('RESEARCH');
  });

  it('FAIRNESS is SOFT: only the just-done type available → it is STILL taken (no idle)', async () => {
    const counts = new WoTypeRecentCounts(60_000);
    for (let i = 0; i < 5; i++) counts.record('TRAINING');
    node.__setRecentCountsForTests(counts);

    // ONLY TRAINING available this tick (the recently-done type).
    pushQueue.drain.mockReturnValue([trainingPushed]);
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([]);
    (node as any).pollsSinceFullResync = FULL_RESYNC_EVERY_N_POLLS;

    const out = await node.execute(baseState);

    expect(out.availableWorkOrders).toHaveLength(1);
    expect(out.availableWorkOrders?.[0]?.type).toBe('TRAINING');
  });

  it('CAPABILITY: a type whose requiredCapabilities the node lacks is never surfaced', async () => {
    // Node lacks `gpu_inference`; a GPU_INFERENCE WO arrives via poll.
    const gpuWo: WorkOrder = {
      ...researchHttp,
      id: 'wo-gpu-1',
      type: 'GPU_INFERENCE',
      requiredCapabilities: ['gpu_inference'],
    };
    pushQueue.drain.mockReturnValue([trainingPushed]);
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([gpuWo]);
    (node as any).pollsSinceFullResync = FULL_RESYNC_EVERY_N_POLLS;

    const out = await node.execute(baseState);

    const ids = (out.availableWorkOrders ?? []).map((wo) => wo.id);
    expect(ids).not.toContain('wo-gpu-1');
    expect(ids).toContain('wo-train-1');
  });
});

describe('WoTypeRecentCounts — sliding window (NOT lifetime)', () => {
  it('decays: records outside the window are not counted', () => {
    const counts = new WoTypeRecentCounts(1000); // 1s window
    const t0 = 1_000_000;
    counts.record('TRAINING', t0);
    counts.record('TRAINING', t0 + 500);
    expect(counts.countFor('TRAINING', t0 + 500)).toBe(2);
    // 1200ms later: the first record (at t0) has aged out of the 1s window.
    expect(counts.countFor('TRAINING', t0 + 1200)).toBe(1);
    // 2000ms later: both have aged out.
    expect(counts.countFor('TRAINING', t0 + 2000)).toBe(0);
  });

  it('untyped WOs do not participate', () => {
    const counts = new WoTypeRecentCounts(1000);
    counts.record(undefined);
    expect(counts.countFor(undefined)).toBe(0);
  });
});
