/**
 * D-P2P Slice 0.5 (2026-05-28) — FetchWorkOrdersNode drain path.
 *
 * Pre-Slice 0.5: WorkOrderPushQueue was wired into the gossipsub
 * subscription handler in node-runtime.ts but no consumer ever called
 * `drain()` — entries silently expired at TTL (60s) while every WO
 * discovery still went through the HTTP fallback. See
 * `/tmp/d-p2p-drain-check-2026-05-28.md` verdict (A).
 *
 * This suite covers the new drain-first behaviour:
 *   1. drain returns entries → HTTP fallback NOT called, state shaped from drain.
 *   2. drain returns [] → HTTP fallback invoked.
 *   3. drain throws → fail-closed to HTTP (P2 — never silent swallow).
 *   4. drain hit emits the structured `[D-P2P] drained N from gossipsub` log.
 *   5. PushedWorkOrder → WorkOrder mapping preserves all required fields.
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
import {
  getDiscoverySourceCounter,
  __resetDiscoverySourceCounterForTests,
} from '../../../../telemetry';

describe('FetchWorkOrdersNode — D-P2P Slice 0.5 push queue drain path', () => {
  let coordinator: { fetchAvailableWorkOrders: jest.Mock };
  let execution: {
    isResearchWorkOrder: jest.Mock;
    isTrainingWorkOrder: jest.Mock;
    isDiLoCoWorkOrder: jest.Mock;
  };
  let backpressure: {
    canAccept: jest.Mock;
    getInFlight: jest.Mock;
    getMaxConcurrent: jest.Mock;
    getInFlightByClass: jest.Mock;
    getMaxByClass: jest.Mock;
    isDraining: jest.Mock;
  };
  let pushQueue: {
    drain: jest.Mock;
    size: jest.Mock;
  };
  let node: FetchWorkOrdersNode;
  let logSpy: jest.SpiedFunction<typeof logger.log>;
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;
  let infoSpy: jest.SpiedFunction<typeof logger.info>;

  const cpuInferencePushed: PushedWorkOrder = {
    id: 'wo-pushed-1',
    title: 'Pushed CPU inference',
    description: 'desc',
    type: 'CPU_INFERENCE',
    status: 'AVAILABLE',
    rewardAmount: '1000',
    requiredCapabilities: ['cpu_inference'],
    creatorAddress: 'creator-1',
    createdAt: 1716800000000,
    receivedAt: Date.now(),
  };

  const dilocoPushed: PushedWorkOrder = {
    id: 'wo-pushed-2',
    title: 'Pushed DiLoCo',
    description: 'desc-2',
    type: 'DILOCO_TRAINING',
    status: 'AVAILABLE',
    rewardAmount: '5000',
    requiredCapabilities: ['diloco_training'],
    creatorAddress: 'creator-2',
    createdAt: '2026-05-28T10:00:00.000Z',
    receivedAt: Date.now(),
    metadata: { hint: 'fast', extra: 42 as unknown as string },
  };

  const cpuInferenceHttp: WorkOrder = {
    id: 'wo-http-1',
    title: 'HTTP CPU inference',
    description: 'http',
    requiredCapabilities: ['cpu_inference'],
    rewardAmount: '999',
    status: 'PENDING',
    creatorAddress: 'creator-http',
    createdAt: 0,
    type: 'CPU_INFERENCE',
  };

  const baseState = {
    coordinatorUrl: 'http://coord',
    peerId: 'peer-1',
    capabilities: ['cpu_inference', 'diloco_training'],
    rejectedWorkOrderIds: [],
  } as any;

  beforeEach(() => {
    coordinator = { fetchAvailableWorkOrders: jest.fn() };
    execution = {
      isResearchWorkOrder: jest.fn().mockReturnValue(false),
      isTrainingWorkOrder: jest.fn().mockReturnValue(false),
      isDiLoCoWorkOrder: jest.fn().mockReturnValue(false),
    };
    backpressure = {
      canAccept: jest.fn().mockReturnValue(true),
      getInFlight: jest.fn().mockReturnValue(0),
      getMaxConcurrent: jest.fn().mockReturnValue(4),
      getInFlightByClass: jest.fn().mockReturnValue(0),
      getMaxByClass: jest.fn().mockImplementation((cls: string) => (cls === 'HEAVY' ? 1 : 2)),
      isDraining: jest.fn().mockReturnValue(false),
    };
    pushQueue = {
      drain: jest.fn().mockReturnValue([]),
      size: jest.fn().mockReturnValue(0),
    };
    node = new FetchWorkOrdersNode(
      coordinator as any,
      execution as any,
      backpressure as any,
      pushQueue as any,
    );
    __seedCapabilitySnapshotForTests(['cpu_inference', 'diloco_training']);
    // D-P2P Slice 1 — discovery-source singleton is process-wide;
    // reset between specs so cross-test bleed can't fake an increment.
    __resetDiscoverySourceCounterForTests();
    logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    __resetCapabilitySnapshotForTests();
    __resetDiscoverySourceCounterForTests();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('drain returns 2 entries → HTTP fallback is NOT called and state.workOrders has 2 entries', async () => {
    pushQueue.drain.mockReturnValue([cpuInferencePushed, dilocoPushed]);
    pushQueue.size.mockReturnValue(0);
    execution.isDiLoCoWorkOrder.mockImplementation((wo: any) => wo.type === 'DILOCO_TRAINING');

    const out = await node.execute(baseState);

    expect(coordinator.fetchAvailableWorkOrders).not.toHaveBeenCalled();
    expect(out.availableWorkOrders).toHaveLength(2);
    expect(out.availableWorkOrders?.map((wo: WorkOrder) => wo.id)).toEqual([
      'wo-pushed-1',
      'wo-pushed-2',
    ]);
  });

  it('drain returns [] → HTTP fallback IS invoked and state.workOrders matches HTTP result', async () => {
    pushQueue.drain.mockReturnValue([]);
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([cpuInferenceHttp]);

    const out = await node.execute(baseState);

    expect(coordinator.fetchAvailableWorkOrders).toHaveBeenCalledTimes(1);
    expect(out.availableWorkOrders).toEqual([cpuInferenceHttp]);
  });

  it('drain throws → fail-closed: warns and falls back to HTTP (P2 — never silent swallow)', async () => {
    pushQueue.drain.mockImplementation(() => {
      throw new Error('queue corrupted');
    });
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([cpuInferenceHttp]);

    const out = await node.execute(baseState);

    expect(coordinator.fetchAvailableWorkOrders).toHaveBeenCalledTimes(1);
    expect(out.availableWorkOrders).toEqual([cpuInferenceHttp]);
    // Must have logged the failure — never silent.
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0] ?? ''));
    expect(warnCalls.some((m) => m.includes('pushQueue.drain() threw'))).toBe(true);
    expect(warnCalls.some((m) => m.includes('queue corrupted'))).toBe(true);
  });

  it('emits the structured `[D-P2P] drained N from gossipsub` log when drain hits', async () => {
    pushQueue.drain.mockReturnValue([cpuInferencePushed]);
    pushQueue.size.mockReturnValue(3);

    await node.execute(baseState);

    const logCalls = logSpy.mock.calls.map((c) => String(c[0] ?? ''));
    expect(
      logCalls.some((m) =>
        m.startsWith('[D-P2P] drained 1 from gossipsub (queue size=3)'),
      ),
    ).toBe(true);
  });

  it('D-P2P Slice 1 — gossipsub drain hit bumps the source counter by pushed.length (BEFORE filters)', async () => {
    pushQueue.drain.mockReturnValue([cpuInferencePushed, dilocoPushed]);
    pushQueue.size.mockReturnValue(0);
    execution.isDiLoCoWorkOrder.mockImplementation((wo: any) => wo.type === 'DILOCO_TRAINING');
    const counter = getDiscoverySourceCounter();
    const incSpy = jest.spyOn(counter, 'increment');

    await node.execute(baseState);

    // EXACTLY one call with ('gossipsub', 2). HTTP path NOT touched.
    const gossipsubCalls = incSpy.mock.calls.filter((c) => c[0] === 'gossipsub');
    const pollCalls = incSpy.mock.calls.filter((c) => c[0] === 'poll');
    expect(gossipsubCalls).toHaveLength(1);
    expect(gossipsubCalls[0]).toEqual(['gossipsub', 2]);
    expect(pollCalls).toHaveLength(0);

    incSpy.mockRestore();
  });

  it('D-P2P Slice 1 — empty drain + HTTP fallback returns N → counter bumped by N on poll side', async () => {
    pushQueue.drain.mockReturnValue([]);
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([cpuInferenceHttp, { ...cpuInferenceHttp, id: 'wo-http-2' }]);
    const counter = getDiscoverySourceCounter();
    const incSpy = jest.spyOn(counter, 'increment');

    await node.execute(baseState);

    const gossipsubCalls = incSpy.mock.calls.filter((c) => c[0] === 'gossipsub');
    const pollCalls = incSpy.mock.calls.filter((c) => c[0] === 'poll');
    expect(gossipsubCalls).toHaveLength(0);
    expect(pollCalls).toHaveLength(1);
    expect(pollCalls[0]).toEqual(['poll', 2]);

    incSpy.mockRestore();
  });

  it('D-P2P Slice 1 — empty drain + empty HTTP result does NOT touch the counter', async () => {
    pushQueue.drain.mockReturnValue([]);
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([]);
    const counter = getDiscoverySourceCounter();
    const incSpy = jest.spyOn(counter, 'increment');

    await node.execute(baseState);

    expect(incSpy).not.toHaveBeenCalled();

    incSpy.mockRestore();
  });

  it('D-P2P Slice 1 — drain throws → HTTP fallback bumps poll counter, NOT gossipsub', async () => {
    pushQueue.drain.mockImplementation(() => {
      throw new Error('queue corrupted');
    });
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([cpuInferenceHttp]);
    const counter = getDiscoverySourceCounter();
    const incSpy = jest.spyOn(counter, 'increment');

    await node.execute(baseState);

    const gossipsubCalls = incSpy.mock.calls.filter((c) => c[0] === 'gossipsub');
    const pollCalls = incSpy.mock.calls.filter((c) => c[0] === 'poll');
    expect(gossipsubCalls).toHaveLength(0);
    expect(pollCalls).toHaveLength(1);
    expect(pollCalls[0]).toEqual(['poll', 1]);

    incSpy.mockRestore();
  });

  describe('D-P2P Slice 0.6 — SYNAPSEIA_DISABLE_WO_POLL killswitch (in-node)', () => {
    let savedEnv: string | undefined;
    beforeEach(() => {
      savedEnv = process.env.SYNAPSEIA_DISABLE_WO_POLL;
    });
    afterEach(() => {
      if (savedEnv === undefined) {
        delete process.env.SYNAPSEIA_DISABLE_WO_POLL;
      } else {
        process.env.SYNAPSEIA_DISABLE_WO_POLL = savedEnv;
      }
    });

    it('KILLSWITCH ON + drain empty → returns [] WITHOUT calling the HTTP fallback', async () => {
      process.env.SYNAPSEIA_DISABLE_WO_POLL = 'true';
      pushQueue.drain.mockReturnValue([]);
      coordinator.fetchAvailableWorkOrders.mockResolvedValue([cpuInferenceHttp]);

      const out = await node.execute(baseState);

      expect(coordinator.fetchAvailableWorkOrders).not.toHaveBeenCalled();
      expect(out.availableWorkOrders).toEqual([]);
      // Visible log so the operator sees the killswitch in effect.
      const logCalls = logSpy.mock.calls.map((c) => String(c[0] ?? ''));
      expect(
        logCalls.some((m) => m.includes('WO HTTP poll disabled by killswitch')),
      ).toBe(true);
    });

    it("KILLSWITCH OFF (env unset) + drain empty → HTTP fallback IS called (existing behaviour)", async () => {
      delete process.env.SYNAPSEIA_DISABLE_WO_POLL;
      pushQueue.drain.mockReturnValue([]);
      coordinator.fetchAvailableWorkOrders.mockResolvedValue([cpuInferenceHttp]);

      const out = await node.execute(baseState);

      expect(coordinator.fetchAvailableWorkOrders).toHaveBeenCalledTimes(1);
      expect(out.availableWorkOrders).toEqual([cpuInferenceHttp]);
    });

    it("KILLSWITCH 'false' literal + drain empty → HTTP fallback IS called", async () => {
      process.env.SYNAPSEIA_DISABLE_WO_POLL = 'false';
      pushQueue.drain.mockReturnValue([]);
      coordinator.fetchAvailableWorkOrders.mockResolvedValue([cpuInferenceHttp]);

      const out = await node.execute(baseState);

      expect(coordinator.fetchAvailableWorkOrders).toHaveBeenCalledTimes(1);
      expect(out.availableWorkOrders).toEqual([cpuInferenceHttp]);
    });

    it("KILLSWITCH 'TRUE' (case-insensitive) + drain empty → no HTTP fallback", async () => {
      process.env.SYNAPSEIA_DISABLE_WO_POLL = 'TRUE';
      pushQueue.drain.mockReturnValue([]);
      coordinator.fetchAvailableWorkOrders.mockResolvedValue([cpuInferenceHttp]);

      const out = await node.execute(baseState);

      expect(coordinator.fetchAvailableWorkOrders).not.toHaveBeenCalled();
      expect(out.availableWorkOrders).toEqual([]);
    });

    it('KILLSWITCH ON + drain throws → returns [] WITHOUT HTTP fallback (P2 fail-closed)', async () => {
      process.env.SYNAPSEIA_DISABLE_WO_POLL = 'true';
      pushQueue.drain.mockImplementation(() => {
        throw new Error('queue corrupted');
      });
      coordinator.fetchAvailableWorkOrders.mockResolvedValue([cpuInferenceHttp]);

      const out = await node.execute(baseState);

      expect(coordinator.fetchAvailableWorkOrders).not.toHaveBeenCalled();
      expect(out.availableWorkOrders).toEqual([]);
      // Drain error still logged at WARN — never silently swallowed.
      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0] ?? ''));
      expect(warnCalls.some((m) => m.includes('pushQueue.drain() threw'))).toBe(true);
    });

    it('KILLSWITCH ON + drain returns entries → entries pass through unchanged (no HTTP)', async () => {
      process.env.SYNAPSEIA_DISABLE_WO_POLL = 'true';
      pushQueue.drain.mockReturnValue([cpuInferencePushed]);
      pushQueue.size.mockReturnValue(0);

      const out = await node.execute(baseState);

      expect(coordinator.fetchAvailableWorkOrders).not.toHaveBeenCalled();
      expect(out.availableWorkOrders).toHaveLength(1);
      expect(out.availableWorkOrders![0]!.id).toBe('wo-pushed-1');
    });
  });

  it('PushedWorkOrder → WorkOrder mapping preserves id, type, rewardAmount, requiredCapabilities, creatorAddress', async () => {
    pushQueue.drain.mockReturnValue([dilocoPushed]);
    execution.isDiLoCoWorkOrder.mockImplementation((wo: any) => wo.type === 'DILOCO_TRAINING');

    const out = await node.execute(baseState);

    expect(out.availableWorkOrders).toHaveLength(1);
    const mapped = out.availableWorkOrders![0]!;
    expect(mapped.id).toBe('wo-pushed-2');
    expect(mapped.title).toBe('Pushed DiLoCo');
    expect(mapped.description).toBe('desc-2');
    expect(mapped.type).toBe('DILOCO_TRAINING');
    expect(mapped.rewardAmount).toBe('5000');
    expect(mapped.requiredCapabilities).toEqual(['diloco_training']);
    expect(mapped.creatorAddress).toBe('creator-2');
    // 'AVAILABLE' coerces to 'PENDING' (only valid pre-accept status in LangGraph union).
    expect(mapped.status).toBe('PENDING');
    // ISO string parsed to epoch ms.
    expect(mapped.createdAt).toBe(Date.parse('2026-05-28T10:00:00.000Z'));
    // metadata: non-string values stringified.
    expect(mapped.metadata).toEqual({ hint: 'fast', extra: '42' });
  });
});
