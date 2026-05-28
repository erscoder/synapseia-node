/**
 * D-P2P Slice 0.6 (2026-05-28) — LangGraphWorkOrderAgentService
 * `kickIteration()` + interruptable sleep coverage.
 *
 * The agent's runLoop is the LANDING ZONE for gossipsub-driven push
 * discovery: the push queue's wake hook fires kickIteration() and the
 * loop must either (a) break out of its current sleep window or (b)
 * skip the upcoming sleep if mid-iter. This spec exercises both paths
 * + the debounce / safety windows called out in the source comments
 * (kickIteration before start, during stop, 100 rapid kicks → 1 wake).
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { LangGraphWorkOrderAgentService } from '../langgraph-work-order-agent.service';
import type { WorkOrderAgentConfig } from '../../work-order/work-order.types';

type AsyncFn<T = void> = () => Promise<T>;

function makeConfig(overrides: Partial<WorkOrderAgentConfig> = {}): WorkOrderAgentConfig {
  return {
    coordinatorUrl: 'http://coord.local',
    peerId: 'peer-test',
    walletAddress: 'wallet-test',
    capabilities: ['cpu_inference'],
    llmModel: { provider: 'ollama', model: 'mistral:7b' } as unknown as WorkOrderAgentConfig['llmModel'],
    llmConfig: { provider: 'ollama' } as unknown as WorkOrderAgentConfig['llmConfig'],
    intervalMs: 1_000,
    maxIterations: 2,
    ...overrides,
  };
}

function makeService(opts: {
  iterImpl?: AsyncFn<{ workOrder: undefined; completed: false }>;
} = {}): {
  svc: LangGraphWorkOrderAgentService;
  agentGraphService: { runIteration: jest.Mock };
} {
  const agentGraphService = {
    runIteration: jest.fn(
      opts.iterImpl ??
        (() => Promise.resolve({ workOrder: undefined, completed: false })),
    ),
  };
  const agentBrainHelper = {
    initBrain: jest.fn(() => ({}) as unknown),
  };
  const roundListenerHelper = {
    startRoundListener: jest.fn(),
  };
  const svc = new LangGraphWorkOrderAgentService(
    agentGraphService as never,
    agentBrainHelper as never,
    roundListenerHelper as never,
  );
  return { svc, agentGraphService };
}

describe('LangGraphWorkOrderAgentService — Slice 0.6 kickIteration', () => {
  let realSetTimeout: typeof setTimeout;

  beforeEach(() => {
    realSetTimeout = global.setTimeout;
  });

  afterEach(() => {
    global.setTimeout = realSetTimeout;
    jest.useRealTimers();
  });

  it('kickIteration() when not running → no-op (does not throw, does not start)', () => {
    const { svc, agentGraphService } = makeService();
    // Never called start() → isRunning false. Must be safe to call.
    expect(() => svc.kickIteration()).not.toThrow();
    expect(agentGraphService.runIteration).not.toHaveBeenCalled();
    expect(svc.getState().isRunning).toBe(false);
  });

  it('kickIteration() during sleep → interrupts the sleep and next iter starts immediately', async () => {
    // Iter completes instantly. Default sleep = 1000ms. We start, wait
    // until iter 1 finished and the loop has entered sleep(), then
    // kickIteration() and assert iter 2 fires within ~tens of ms, NOT
    // after 1 second.
    const { svc, agentGraphService } = makeService();
    const cfg = makeConfig({ intervalMs: 5_000, maxIterations: 2 });
    const runPromise = svc.start(cfg);
    // Yield enough microtasks for iter 1 to land + enter sleep().
    await new Promise<void>((r) => realSetTimeout(r, 20));
    expect(agentGraphService.runIteration).toHaveBeenCalledTimes(1);

    const tKick = Date.now();
    svc.kickIteration();
    await runPromise;
    const elapsed = Date.now() - tKick;
    // Iter 2 should have happened immediately on kick — anything over
    // 250ms means we waited for the 5_000ms sleep, which is the bug.
    expect(elapsed).toBeLessThan(250);
    expect(agentGraphService.runIteration).toHaveBeenCalledTimes(2);
  });

  it('kickIteration() during runIteration → next sleep is SKIPPED, iter 2 starts immediately after iter 1', async () => {
    // Make iter 1 take 100ms; kick fires during that window. Loop must
    // then SKIP the (5_000ms) sleep entirely and start iter 2 right after.
    let iter1Resolve!: () => void;
    const iter1Done = new Promise<void>((r) => {
      iter1Resolve = r;
    });
    const iterCalls: number[] = [];
    const { svc, agentGraphService } = makeService({
      iterImpl: jest.fn(() => {
        const callId = iterCalls.length + 1;
        iterCalls.push(callId);
        if (callId === 1) {
          return iter1Done.then(() => ({ workOrder: undefined, completed: false }));
        }
        return Promise.resolve({ workOrder: undefined, completed: false });
      }),
    });
    const cfg = makeConfig({ intervalMs: 5_000, maxIterations: 2 });
    const runPromise = svc.start(cfg);
    // Wait until iter 1 is in-flight.
    await new Promise<void>((r) => realSetTimeout(r, 20));
    expect(agentGraphService.runIteration).toHaveBeenCalledTimes(1);
    // Kick DURING iter — should set shouldKickNext (not break sleep, no sleep yet).
    svc.kickIteration();
    // Now let iter 1 finish.
    const t0 = Date.now();
    iter1Resolve();
    await runPromise;
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(250); // sleep skipped — no 5s wait
    expect(agentGraphService.runIteration).toHaveBeenCalledTimes(2);
  });

  it('100 rapid kickIteration() calls collapse into a SINGLE wake (idempotent / debounced)', async () => {
    const { svc, agentGraphService } = makeService();
    const cfg = makeConfig({ intervalMs: 5_000, maxIterations: 2 });
    const runPromise = svc.start(cfg);
    await new Promise<void>((r) => realSetTimeout(r, 20));
    expect(agentGraphService.runIteration).toHaveBeenCalledTimes(1);

    // 100 kicks while sleeping — only the first matters; the rest are
    // no-ops because sleepResolver is already null after the first kick.
    for (let i = 0; i < 100; i++) svc.kickIteration();
    await runPromise;

    // Iter count must be exactly the configured maxIterations (2), not
    // 100. Anything > 2 means the kicks spuriously ran extra iters.
    expect(agentGraphService.runIteration).toHaveBeenCalledTimes(2);
  });

  it('stop() during sleep → interrupts the sleep, loop exits immediately', async () => {
    const { svc, agentGraphService } = makeService();
    const cfg = makeConfig({ intervalMs: 5_000, maxIterations: 10 });
    const runPromise = svc.start(cfg);
    await new Promise<void>((r) => realSetTimeout(r, 20));
    expect(agentGraphService.runIteration).toHaveBeenCalledTimes(1);

    const t0 = Date.now();
    svc.stop();
    await runPromise;
    const elapsed = Date.now() - t0;
    // Without sleep interruption stop() would have to wait 5_000ms.
    expect(elapsed).toBeLessThan(250);
    expect(svc.getState().isRunning).toBe(false);
  });

  it('kickIteration() after stop() → no-op (does not resurrect the loop)', async () => {
    const { svc, agentGraphService } = makeService();
    const cfg = makeConfig({ intervalMs: 5_000, maxIterations: 1 });
    await svc.start(cfg);
    expect(svc.getState().isRunning).toBe(false);
    expect(agentGraphService.runIteration).toHaveBeenCalledTimes(1);

    svc.kickIteration();
    // No new iter should have happened.
    await new Promise<void>((r) => realSetTimeout(r, 50));
    expect(agentGraphService.runIteration).toHaveBeenCalledTimes(1);
  });

  it('errors in runIteration do not stop the loop and kickIteration still works', async () => {
    let callCount = 0;
    const { svc, agentGraphService } = makeService({
      iterImpl: jest.fn(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('boom'));
        return Promise.resolve({ workOrder: undefined, completed: false });
      }),
    });
    const cfg = makeConfig({ intervalMs: 5_000, maxIterations: 2 });
    const runPromise = svc.start(cfg);
    await new Promise<void>((r) => realSetTimeout(r, 20));
    // Iter 1 has thrown; loop should be in sleep before iter 2.
    expect(agentGraphService.runIteration).toHaveBeenCalledTimes(1);
    svc.kickIteration();
    await runPromise;
    expect(agentGraphService.runIteration).toHaveBeenCalledTimes(2);
  });
});
