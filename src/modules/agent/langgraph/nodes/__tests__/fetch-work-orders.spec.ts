/**
 * Bug 25 — FetchWorkOrdersNode pre-fetch capability filter.
 *
 * Bug 22 (2026-05-17) introduced an intersection
 *   `effectiveCaps = state.capabilities ∩ live`
 * to strip caps the heartbeat had removed under memory pressure.
 *
 * Bug 25 (same day, regression) — the intersection also dropped caps
 * that the heartbeat ADDED async after boot (e.g. `diloco_training`,
 * `lora_training`, `docking` — gated on marker files / cgroup / model
 * probes that only resolve in the first heartbeat tick). Result: pod
 * never accepted DiLoCo / LoRA / Docking WOs even though coord knew
 * the pod advertised the cap.
 *
 * Fix: trust LIVE heartbeat caps. The state.capabilities field is now
 * only used as a pre-primer fallback (heartbeat returns `[]` before
 * the first announce lands).
 *
 * P3 reviewer-lesson — live/state mismatch was a race condition (state
 * stale forever). Document that live is authoritative.
 *
 * P29 reviewer-lesson — exercise the REAL intersection / fallback logic
 * via the seeded heartbeat snapshot (`__seedCapabilitySnapshotForTests`),
 * not a mock that lies about the result.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { FetchWorkOrdersNode } from '../fetch-work-orders';
import type { WorkOrder } from '../../../work-order/work-order.types';
import logger from '../../../../../utils/logger';
import {
  __seedCapabilitySnapshotForTests,
  __resetCapabilitySnapshotForTests,
} from '../../../../heartbeat/heartbeat';

describe('FetchWorkOrdersNode — Bug 25 effectiveCaps trusts live heartbeat', () => {
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
  };
  let node: FetchWorkOrdersNode;
  let infoSpy: jest.SpiedFunction<typeof logger.info>;
  let logSpy: jest.SpiedFunction<typeof logger.log>;

  const dilocoWO: WorkOrder = {
    id: 'wo-diloco-1',
    title: 'DiLoCo round 1',
    description: 'd',
    requiredCapabilities: ['diloco_training'],
    rewardAmount: '1',
    status: 'AVAILABLE',
    creatorAddress: 'creator',
    createdAt: 0,
    type: 'DILOCO_TRAINING',
  };

  const cpuInferenceWO: WorkOrder = {
    id: 'wo-cpu-1',
    title: 'CPU inference',
    description: 'd',
    requiredCapabilities: ['cpu_inference'],
    rewardAmount: '1',
    status: 'AVAILABLE',
    creatorAddress: 'creator',
    createdAt: 0,
    type: 'CPU_INFERENCE',
  };

  // State capabilities = boot-time SYNC snapshot. Lacks async-added caps.
  const baseState = {
    coordinatorUrl: 'http://coord',
    peerId: 'peer-1',
    capabilities: ['cpu_inference', 'gpu_training'],
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
    };
    node = new FetchWorkOrdersNode(
      coordinator as any,
      execution as any,
      backpressure as any,
    );
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    __resetCapabilitySnapshotForTests();
    infoSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('accepts WOs whose cap is in LIVE but NOT in state (async-added cap, Bug 25 repro)', async () => {
    // Heartbeat tick added `diloco_training` after the marker file
    // appeared. State snapshot (frozen at boot) does NOT list it.
    __seedCapabilitySnapshotForTests([
      'cpu_inference',
      'gpu_training',
      'diloco_training', // async-added — would be erased by intersection
    ]);

    coordinator.fetchAvailableWorkOrders.mockResolvedValue([dilocoWO]);
    // DiLoCo WO is treated as a DiLoCo work order by the execution helper.
    execution.isDiLoCoWorkOrder.mockReturnValue(true);

    const out = await node.execute(baseState);

    // Pre-Bug-25, this returned `[]` because effectiveCaps stripped
    // `diloco_training` and `canLocallyAcceptWorkOrder` rejected the WO.
    expect(out.availableWorkOrders).toEqual([dilocoWO]);
  });

  it('falls back to state capabilities when LIVE is empty (pre-primer)', async () => {
    // Heartbeat has not announced yet (`lastAnnouncedCapabilities = null`
    // → `getCurrentCapabilities()` returns `[]`).
    __seedCapabilitySnapshotForTests(null);

    coordinator.fetchAvailableWorkOrders.mockResolvedValue([cpuInferenceWO]);

    const out = await node.execute(baseState);

    // State still has `cpu_inference` so the WO passes the pre-fetch
    // filter. The final hard guard is in accept-wo.ts (fails closed on
    // pre-primer per wo-type-to-cap.ts:100).
    expect(out.availableWorkOrders).toEqual([cpuInferenceWO]);
  });

  it('rejects WOs whose cap was stripped from LIVE (memory pressure scenario, Bug 22 still holds)', async () => {
    // State boot snapshot had `diloco_training` but live heartbeat
    // stripped it (e.g. freemem < threshold → `diloco_training`
    // filtered out by the per-cap memory gate). State here is
    // augmented to include diloco_training to prove "live wins".
    __seedCapabilitySnapshotForTests(['cpu_inference']);

    coordinator.fetchAvailableWorkOrders.mockResolvedValue([dilocoWO]);
    execution.isDiLoCoWorkOrder.mockReturnValue(true);

    const out = await node.execute({
      ...baseState,
      capabilities: ['cpu_inference', 'diloco_training'],
    });

    // diloco_training was stripped from live; WO must be filtered out
    // even though state still lists it. Validates that live overrides
    // (not just unions) state — Bug 22 invariant.
    expect(out.availableWorkOrders).toEqual([]);
  });

  it('uses ONLY live caps when live and state overlap (no leak from state)', async () => {
    // State lists `cpu_training` (boot-time). Live lists
    // `cpu_inference` and `diloco_training` but NOT `cpu_training`
    // (stripped). A TRAINING WO (requires cpu_training) must be
    // rejected — live wins.
    __seedCapabilitySnapshotForTests(['cpu_inference', 'diloco_training']);

    const trainingWO: WorkOrder = {
      ...dilocoWO,
      id: 'wo-t-leak',
      title: 'CPU training',
      requiredCapabilities: ['cpu_training'],
      type: 'TRAINING',
    };

    coordinator.fetchAvailableWorkOrders.mockResolvedValue([trainingWO, dilocoWO]);
    execution.isTrainingWorkOrder.mockImplementation((wo: any) =>
      wo.type === 'TRAINING',
    );
    execution.isDiLoCoWorkOrder.mockImplementation((wo: any) =>
      wo.type === 'DILOCO_TRAINING',
    );

    const out = await node.execute(baseState);

    // cpu_training WO rejected (not in live); diloco WO accepted
    // (in live, not in state — Bug 25 path).
    expect(out.availableWorkOrders).toEqual([dilocoWO]);
  });

  it('returns empty when backpressure is at capacity (orthogonal guard still works)', async () => {
    __seedCapabilitySnapshotForTests(['cpu_inference', 'diloco_training']);
    backpressure.canAccept.mockReturnValue(false);
    backpressure.getInFlight.mockReturnValue(4);

    const out = await node.execute(baseState);

    expect(out.availableWorkOrders).toEqual([]);
    expect(coordinator.fetchAvailableWorkOrders).not.toHaveBeenCalled();
  });

  it('returns empty when coordinator returns no WOs (no spurious processing)', async () => {
    __seedCapabilitySnapshotForTests(['cpu_inference', 'diloco_training']);
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([]);

    const out = await node.execute(baseState);

    expect(out.availableWorkOrders).toEqual([]);
  });

  it('skips WOs already rejected by economics (rejectedWorkOrderIds branch)', async () => {
    __seedCapabilitySnapshotForTests(['cpu_inference']);
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([cpuInferenceWO]);

    const out = await node.execute({
      ...baseState,
      rejectedWorkOrderIds: [cpuInferenceWO.id],
    });

    expect(out.availableWorkOrders).toEqual([]);
  });

  it('skips research WOs on cooldown after setResearchCooldown / markCompleted', async () => {
    // RESEARCH maps to OR-set ['inference','llm'] (wo-type-to-cap.ts).
    __seedCapabilitySnapshotForTests(['inference']);
    const researchWO: WorkOrder = {
      ...cpuInferenceWO,
      id: 'wo-r-1',
      title: 'Research',
      requiredCapabilities: ['inference'],
      type: 'RESEARCH',
    };
    execution.isResearchWorkOrder.mockImplementation((wo: any) => wo.type === 'RESEARCH');
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([researchWO]);

    // First call — no cooldown, WO accepted.
    const first = await node.execute(baseState);
    expect(first.availableWorkOrders).toEqual([researchWO]);

    // Mark completed (sets research cooldown).
    node.markCompleted(researchWO);

    // Second call — cooldown active, WO filtered.
    const second = await node.execute(baseState);
    expect(second.availableWorkOrders).toEqual([]);

    // setResearchCooldown is an alternate entry — exercise it too.
    node.reset();
    node.setResearchCooldown(researchWO.id);
    const third = await node.execute(baseState);
    expect(third.availableWorkOrders).toEqual([]);
  });

  it('skips training WOs on cooldown after markCompleted, then accepts after reset()', async () => {
    // TRAINING → cpu_training (wo-type-to-cap.ts).
    __seedCapabilitySnapshotForTests(['cpu_training', 'diloco_training', 'cpu_inference']);
    const trainingWO: WorkOrder = {
      ...cpuInferenceWO,
      id: 'wo-t-1',
      title: 'Training',
      requiredCapabilities: ['cpu_training'],
      type: 'TRAINING',
    };
    execution.isTrainingWorkOrder.mockImplementation((wo: any) => wo.type === 'TRAINING');
    execution.isDiLoCoWorkOrder.mockImplementation((wo: any) => wo.type === 'DILOCO_TRAINING');
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([trainingWO]);

    // Accept.
    const first = await node.execute(baseState);
    expect(first.availableWorkOrders).toEqual([trainingWO]);

    // markCompleted on a TRAINING WO → trainingCooldowns set.
    node.markCompleted(trainingWO);
    const second = await node.execute(baseState);
    expect(second.availableWorkOrders).toEqual([]);

    // markCompleted on a DiLoCo WO → also routed to trainingCooldowns.
    const dilocoOther: WorkOrder = { ...dilocoWO, id: 'wo-d-2' };
    node.markCompleted(dilocoOther);

    // markCompleted on an inference WO → permanent completedWorkOrderIds.
    node.markCompleted(cpuInferenceWO);
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([cpuInferenceWO]);
    const third = await node.execute(baseState);
    expect(third.availableWorkOrders).toEqual([]);

    // reset() clears all three buckets.
    node.reset();
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([trainingWO]);
    const fourth = await node.execute(baseState);
    expect(fourth.availableWorkOrders).toEqual([trainingWO]);
  });

  it('defers training WOs while chat inference is active (mutex branch)', async () => {
    // We need isChatInferenceActive to return true. Mock the module.
    jest.resetModules();
    jest.doMock('../../../../inference/chat-inference-state', () => ({
      isChatInferenceActive: () => true,
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { FetchWorkOrdersNode: FreshNode } = require('../fetch-work-orders');
    const fresh = new FreshNode(coordinator as any, execution as any, backpressure as any);

    __seedCapabilitySnapshotForTests(['cpu_training']);
    const trainingWO: WorkOrder = {
      ...cpuInferenceWO,
      id: 'wo-t-mutex',
      requiredCapabilities: ['cpu_training'],
      type: 'TRAINING',
    };
    execution.isTrainingWorkOrder.mockImplementation((wo: any) => wo.type === 'TRAINING');
    coordinator.fetchAvailableWorkOrders.mockResolvedValue([trainingWO]);

    const out = await fresh.execute(baseState);

    expect(out.availableWorkOrders).toEqual([]);

    jest.dontMock('../../../../inference/chat-inference-state');
  });
});
