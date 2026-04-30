import {
  joinLogArgs,
  makeBootEvent,
  makeGpuSmokeEvent,
  makeShutdownEvent,
  makeSubsystemErrorEvent,
  makeSubsystemWarningEvent,
  makeUncaughtExceptionEvent,
  makeUnhandledRejectionEvent,
  makeWorkOrderFailedEvent,
} from '../event-builder';

const HW = { os: 'darwin', arch: 'arm64', appVersion: '0.7.3' };

describe('joinLogArgs', () => {
  it('joins strings with spaces', () => {
    expect(joinLogArgs(['a', 'b', 'c'])).toBe('a b c');
  });

  it('renders Errors as "Name: message"', () => {
    expect(joinLogArgs([new TypeError('boom')])).toBe('TypeError: boom');
  });

  it('JSON-stringifies plain objects', () => {
    expect(joinLogArgs([{ x: 1 }])).toBe('{"x":1}');
  });

  it('falls back to String() for circular refs', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const out = joinLogArgs([a]);
    expect(typeof out).toBe('string');
  });
});

describe('makeBootEvent', () => {
  it('produces a node.boot event with hardware and context', () => {
    const ev = makeBootEvent(HW, { pid: 123, uptime: 4.2 });
    expect(ev.eventType).toBe('node.boot');
    expect(ev.severity).toBe('info');
    expect(ev.subsystem).toBe('boot');
    expect((ev.context as { pid: number }).pid).toBe(123);
    expect(ev.hwFingerprint.os).toBe('darwin');
  });
});

describe('makeShutdownEvent', () => {
  it('records the reason in both message and context', () => {
    const ev = makeShutdownEvent(HW, 'SIGTERM');
    expect(ev.eventType).toBe('node.shutdown');
    expect(ev.message).toContain('SIGTERM');
    expect((ev.context as { reason: string }).reason).toBe('SIGTERM');
  });
});

describe('makeGpuSmokeEvent', () => {
  it('uses gpu.smoke.passed and severity=info on success', () => {
    const ev = makeGpuSmokeEvent(HW, {
      status: 'passed',
      probe: 'ollama-cuda',
      latencyMs: 240,
      vramUsedMB: 600,
    });
    expect(ev.eventType).toBe('gpu.smoke.passed');
    expect(ev.severity).toBe('info');
    expect(ev.message).toMatch(/passed/);
  });

  it('uses gpu.smoke.failed and severity=warning on failure', () => {
    const ev = makeGpuSmokeEvent(HW, {
      status: 'failed',
      probe: 'ollama-cuda',
      errorMessage: 'CUDA OOM',
      fallbackToCpu: true,
    });
    expect(ev.eventType).toBe('gpu.smoke.failed');
    expect(ev.severity).toBe('warning');
    expect(ev.message).toContain('CUDA OOM');
  });

  it('uses gpu.smoke.skipped when no GPU was detected', () => {
    const ev = makeGpuSmokeEvent(HW, { status: 'skipped', probe: 'cpu' });
    expect(ev.eventType).toBe('gpu.smoke.skipped');
  });
});

describe('makeSubsystemErrorEvent', () => {
  it('infers subsystem from the [Subsystem] prefix in the message', () => {
    const ev = makeSubsystemErrorEvent(HW, ['[Embedding] kaboom']);
    expect(ev.subsystem).toBe('embedding');
    expect(ev.message).toContain('Embedding');
  });

  it('infers training subsystem from [Trainer] prefix', () => {
    const ev = makeSubsystemErrorEvent(HW, ['[Trainer] failed']);
    expect(ev.subsystem).toBe('training');
  });

  it('captures errorName + stack from an Error in the args', () => {
    const err = new TypeError('boom');
    const ev = makeSubsystemErrorEvent(HW, ['[P2P]', err]);
    expect(ev.errorName).toBe('TypeError');
    expect(ev.stack).toBeDefined();
  });

  // --- Extended subsystem mapping (multi-agent, mutation, watchdog) ----

  it.each([
    ['[ResearcherNode] LLM call failed: ...',     'inference'],
    ['[SelfCritiqueNode] Critique failed: ...',   'inference'],
    ['[PlanExecutionNode] Failed to generate plan', 'inference'],
    ['[CriticNode] No researcher output',         'inference'],
    ['[SynthesizerNode] Missing inputs',          'inference'],
    ['[ModelSubscriber] poll failed',             'inference'],
    ['[AgentGraph] iteration=126 failed',         'training'],
    ['[MutationEngine] candidate failed',         'training'],
    ['[CoordWatchdog] reconnecting',              'p2p'],
    ['[Heartbeat] coordinator unreachable',       'other'],
    ['[Backpressure] At capacity',                'other'],
  ])('maps %s → %s', (msg, expected) => {
    const ev = makeSubsystemErrorEvent(HW, [msg]);
    expect(ev.subsystem).toBe(expected);
  });

  // --- Keyword fallback when no [Prefix] is present --------------------

  it('falls back to llm for "Generation failed: ..." with no prefix', () => {
    const ev = makeSubsystemErrorEvent(HW, [
      'Generation failed: model runner has unexpectedly stopped',
    ]);
    expect(ev.subsystem).toBe('llm');
  });

  it('falls back to training for "Mutation engine failed: ..." with no prefix', () => {
    const ev = makeSubsystemErrorEvent(HW, [
      'Mutation engine failed: All mutation candidates failed',
    ]);
    expect(ev.subsystem).toBe('training');
  });

  it('falls back to "other" for unrecognized prefix-less messages', () => {
    const ev = makeSubsystemErrorEvent(HW, ['something went wrong']);
    expect(ev.subsystem).toBe('other');
  });
});

describe('makeSubsystemWarningEvent', () => {
  it('produces severity=warning', () => {
    const ev = makeSubsystemWarningEvent(HW, ['[LLM] slow response']);
    expect(ev.severity).toBe('warning');
    expect(ev.subsystem).toBe('llm');
  });
});

describe('makeUncaughtExceptionEvent', () => {
  it('produces fatal severity + exception.uncaught type', () => {
    const ev = makeUncaughtExceptionEvent(HW, new RangeError('out'));
    expect(ev.eventType).toBe('exception.uncaught');
    expect(ev.severity).toBe('fatal');
    expect(ev.errorName).toBe('RangeError');
  });

  it('wraps non-Error reasons', () => {
    const ev = makeUncaughtExceptionEvent(HW, 'string-error');
    expect(ev.message).toContain('string-error');
  });
});

describe('makeUnhandledRejectionEvent', () => {
  it('produces exception.unhandled-rejection type', () => {
    const ev = makeUnhandledRejectionEvent(HW, new Error('reject!'));
    expect(ev.eventType).toBe('exception.unhandled-rejection');
    expect(ev.severity).toBe('fatal');
  });
});

describe('makeWorkOrderFailedEvent', () => {
  it('packs workOrderId + missionId + reason into context', () => {
    const ev = makeWorkOrderFailedEvent(
      HW,
      { workOrderId: 'wo_1', missionId: 'mis_1', reason: 'OOM', durationMs: 1200 },
      new Error('oom'),
    );
    expect(ev.eventType).toBe('work-order.failed');
    expect(ev.severity).toBe('error');
    expect(ev.subsystem).toBe('training');
    expect((ev.context as { workOrderId: string }).workOrderId).toBe('wo_1');
    expect(ev.errorName).toBe('Error');
  });
});
