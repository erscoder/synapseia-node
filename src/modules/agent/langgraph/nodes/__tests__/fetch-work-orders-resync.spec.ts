/**
 * D-P2P Slice 2 (2026-05-28) — FetchWorkOrdersNode `?since=` cursor +
 * P18 full-resync lateral-guard.
 *
 * The HTTP fallback poll passes the node's monotone `lastSeenSeq` as
 * `?since=` so the coord ships only the delta (`seq > since`). That is a
 * hot-path short-circuit (P18): it SKIPS every WO with `seq <= since`,
 * which silently misses a WO that the coord reset back to assignable
 * WITHOUT minting a new seq (timed-out accept reverted to PENDING, round
 * WO re-released). The full-resync guard polls WITHOUT `?since=` every
 * `FULL_RESYNC_EVERY_N_POLLS` polls AND on every coordinator-change, so
 * those reverted WOs are reconciled. The persisted cursor stays monotone
 * across the resync (it never rewinds).
 *
 * These specs assert the BEHAVIOUR end-to-end against a real
 * `LastSeenSeqStore` (file-backed, isolated tmp path) plus a real
 * `FetchWorkOrdersNode`, exercising the actual cursor-advance + resync
 * decision logic rather than mocking the result (P29).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FetchWorkOrdersNode } from '../fetch-work-orders';
import type { WorkOrder } from '../../../work-order/work-order.types';
import logger from '../../../../../utils/logger';
import { LastSeenSeqStore } from '../../../../../shared/last-seen-seq';
import {
  __seedCapabilitySnapshotForTests,
  __resetCapabilitySnapshotForTests,
} from '../../../../heartbeat/heartbeat';

const FULL_RESYNC_EVERY_N_POLLS = 12; // mirror FetchWorkOrdersNode.FULL_RESYNC_EVERY_N_POLLS

describe('FetchWorkOrdersNode — D-P2P Slice 2 ?since= cursor + P18 full-resync', () => {
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
  let pushQueue: { drain: jest.Mock; size: jest.Mock };
  let node: FetchWorkOrdersNode;
  let seqStore: LastSeenSeqStore;
  let tmpDir: string;
  let logSpy: jest.SpiedFunction<typeof logger.log>;

  // Capture every `since` argument the node passes to the coordinator,
  // in call order, so we can assert the exact cursor sent per poll.
  let sinceCalls: Array<number | undefined>;

  const woWithSeq = (id: string, seq: number, caps: string[] = ['cpu_inference']): WorkOrder => ({
    id,
    title: `WO ${id}`,
    description: 'd',
    requiredCapabilities: caps,
    rewardAmount: '1',
    status: 'AVAILABLE',
    creatorAddress: 'creator',
    createdAt: 0,
    type: 'CPU_INFERENCE',
    seq,
  });

  const baseState = {
    coordinatorUrl: 'http://coord-a',
    peerId: 'peer-1',
    capabilities: ['cpu_inference'],
    rejectedWorkOrderIds: [],
  } as any;

  beforeEach(() => {
    sinceCalls = [];
    coordinator = {
      fetchAvailableWorkOrders: jest.fn(
        async (_url: string, _peer: string, _caps: string[], since?: number) => {
          sinceCalls.push(since);
          return [] as WorkOrder[];
        },
      ),
    };
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-resync-'));
    seqStore = new LastSeenSeqStore({
      path: path.join(tmpDir, 'last-seen-seq.json'),
      flushIntervalMs: 1, // flush eagerly so a re-read in-test sees the latest value
    });

    node = new FetchWorkOrdersNode(
      coordinator as any,
      execution as any,
      backpressure as any,
      pushQueue as any,
    );
    node.__setSeqStoreForTests(seqStore);
    node.__resetResyncStateForTests();

    __seedCapabilitySnapshotForTests(['cpu_inference']);
    logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    __resetCapabilitySnapshotForTests();
    logSpy.mockRestore();
    try {
      seqStore.__resetCacheForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('cold boot poll #1 sends since=undefined (full pool, legacy)', async () => {
    await node.execute(baseState);
    expect(sinceCalls).toEqual([undefined]);
  });

  it('advances lastSeenSeq from the WOs returned and sends it on the NEXT poll', async () => {
    // Poll #1: coord returns WOs with seq 5 and 9 → cursor advances to 9.
    coordinator.fetchAvailableWorkOrders.mockImplementationOnce(
      async (_u: string, _p: string, _c: string[], since?: number) => {
        sinceCalls.push(since);
        return [woWithSeq('wo-5', 5), woWithSeq('wo-9', 9)];
      },
    );
    await node.execute(baseState);
    expect(seqStore.get()).toBe(9);

    // Poll #2: the node must send ?since=9 (the advanced cursor).
    await node.execute(baseState);
    expect(sinceCalls).toEqual([undefined, 9]);
  });

  it('cursor is monotone — a later poll returning a SMALLER seq does not rewind it', async () => {
    coordinator.fetchAvailableWorkOrders.mockImplementationOnce(
      async (_u: string, _p: string, _c: string[], since?: number) => {
        sinceCalls.push(since);
        return [woWithSeq('wo-9', 9)];
      },
    );
    await node.execute(baseState); // cursor → 9
    expect(seqStore.get()).toBe(9);

    coordinator.fetchAvailableWorkOrders.mockImplementationOnce(
      async (_u: string, _p: string, _c: string[], since?: number) => {
        sinceCalls.push(since);
        return [woWithSeq('wo-3', 3)]; // smaller seq (e.g. out-of-order)
      },
    );
    await node.execute(baseState);
    expect(seqStore.get()).toBe(9); // unchanged — monotone guard held
  });

  it('full resync fires on the cadence: the Nth-counter poll drops ?since= and re-fetches the full pool', async () => {
    // Seed a cursor so ordinary polls carry a non-undefined since.
    coordinator.fetchAvailableWorkOrders.mockImplementationOnce(
      async (_u: string, _p: string, _c: string[], since?: number) => {
        sinceCalls.push(since);
        return [woWithSeq('wo-100', 100)];
      },
    );
    await node.execute(baseState); // poll #1 (since=undefined), cursor → 100

    // After poll #1 (idx 0, since=undefined) the cadence counter is 1. Each
    // ordinary delta poll increments it; the resync fires on the poll where
    // the counter first REACHES N. Indices 1..(N-1) are delta polls
    // (counter 1..N-1); index N is the resync poll (counter == N → drops
    // ?since=). Run N more executes so index N is reached.
    for (let i = 0; i < FULL_RESYNC_EVERY_N_POLLS; i++) {
      await node.execute(baseState);
    }

    expect(sinceCalls[0]).toBeUndefined();
    // Exactly two full-pool polls: the cold-boot #1 and the cadence resync.
    const undefinedIdxs = sinceCalls
      .map((v, idx) => (v === undefined ? idx : -1))
      .filter(idx => idx >= 0);
    expect(undefinedIdxs.length).toBe(2);
    // The resync lands at index N (counter reached N on that poll).
    expect(undefinedIdxs[1]).toBe(FULL_RESYNC_EVERY_N_POLLS);
    // Every poll strictly between the two full-pool polls carried the delta cursor.
    for (let i = 1; i < FULL_RESYNC_EVERY_N_POLLS; i++) {
      expect(sinceCalls[i]).toBe(100);
    }
  });

  it('full resync fires immediately on coordinator change (failover / reconnect)', async () => {
    coordinator.fetchAvailableWorkOrders.mockImplementationOnce(
      async (_u: string, _p: string, _c: string[], since?: number) => {
        sinceCalls.push(since);
        return [woWithSeq('wo-50', 50)];
      },
    );
    await node.execute(baseState); // coord-a, since=undefined, cursor → 50
    await node.execute(baseState); // coord-a, since=50 (delta)
    expect(sinceCalls).toEqual([undefined, 50]);

    // Coordinator failover → next poll MUST be a full resync (since=undefined)
    // even though the cadence counter is nowhere near N.
    await node.execute({ ...baseState, coordinatorUrl: 'http://coord-b' });
    expect(sinceCalls[2]).toBeUndefined();

    // And the cursor stays put (monotone) — coord-b returned nothing this tick.
    expect(seqStore.get()).toBe(50);
  });

  it('a reverted WO with an OLD seq is re-surfaced on the full resync (the P18 lateral case)', async () => {
    // Poll #1: WO seq=7 surfaced → cursor → 7.
    coordinator.fetchAvailableWorkOrders.mockImplementationOnce(
      async (_u: string, _p: string, _c: string[], since?: number) => {
        sinceCalls.push(since);
        return [woWithSeq('wo-revert', 7)];
      },
    );
    const first = await node.execute(baseState);
    expect(first.availableWorkOrders).toEqual([woWithSeq('wo-revert', 7)]);

    // Coord changes (forces a resync) → the SAME WO (still seq=7, status
    // reverted to assignable) is shipped by the full-pool query because the
    // resync poll has no `?since=` predicate to filter it out.
    coordinator.fetchAvailableWorkOrders.mockImplementationOnce(
      async (_u: string, _p: string, _c: string[], since?: number) => {
        sinceCalls.push(since);
        // Under a delta query (since=7) the coord would return [] (seq 7 !> 7).
        // Under the resync (since=undefined) it returns the full pool.
        return since === undefined ? [woWithSeq('wo-revert', 7)] : [];
      },
    );
    const resynced = await node.execute({ ...baseState, coordinatorUrl: 'http://coord-b' });
    expect(sinceCalls[1]).toBeUndefined();
    expect(resynced.availableWorkOrders).toEqual([woWithSeq('wo-revert', 7)]);
  });

  it('D-P2P additive discovery (2026-05-31) — gossipsub-drain ticks DO consume the cadence budget so the poll fires periodically even with a perpetually non-empty push queue', async () => {
    // REGRESSION FIX: pre-additive, a gossipsub-drain tick was mutually
    // exclusive with the HTTP poll AND did not consume the cadence budget,
    // so a node whose push queue is never empty NEVER polled → poll-only
    // WO types were never discovered. Now each push-hit tick (poll skipped)
    // spends one unit of the cadence budget, so the Nth tick forces a poll.
    coordinator.fetchAvailableWorkOrders.mockImplementationOnce(
      async (_u: string, _p: string, _c: string[], since?: number) => {
        sinceCalls.push(since);
        return [woWithSeq('wo-1', 30)];
      },
    );
    await node.execute(baseState); // HTTP poll #1, since=undefined, cursor → 30

    // Now a perpetually non-empty push queue (the TRAINING-flood case).
    pushQueue.drain.mockReturnValue([
      {
        id: 'pushed-1',
        title: 'pushed',
        requiredCapabilities: ['cpu_inference'],
        rewardAmount: '1',
        status: 'AVAILABLE',
        creatorAddress: 'creator',
        createdAt: 0,
        type: 'CPU_INFERENCE',
        seq: 31,
      },
    ]);

    // The first N-1 push-hit ticks skip the poll (cadence not yet due).
    for (let i = 0; i < FULL_RESYNC_EVERY_N_POLLS - 1; i++) {
      await node.execute(baseState);
    }
    expect(coordinator.fetchAvailableWorkOrders).toHaveBeenCalledTimes(1);

    // The cadence budget has now reached N → the next tick sees it as due
    // and is FORCED to poll (full resync, since=undefined) even though the
    // push queue is STILL non-empty. A following tick (budget reset to 0)
    // does not poll again — proving the poll is periodic, not every-tick.
    await node.execute(baseState); // forced poll fires here
    await node.execute(baseState); // budget reset → no poll
    expect(coordinator.fetchAvailableWorkOrders).toHaveBeenCalledTimes(2);
    // The forced poll is a full resync (no `?since=`) so reverted WOs are
    // reconciled; the persisted cursor stays monotone (never rewinds).
    expect(sinceCalls[sinceCalls.length - 1]).toBeUndefined();
  });
});
