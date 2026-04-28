import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelemetryClient, TelemetryClientOptions, Scheduler } from '../telemetry';
import { DiskSpool } from '../disk-spool';
import { logger } from '../../../utils/logger';
import {
  makeBootEvent,
  makeSubsystemErrorEvent,
  TelemetryEventInput,
  HwFingerprint,
} from '../event-builder';

const HW: HwFingerprint = { os: 'darwin', arch: 'arm64', appVersion: '0.7.3' };

class ManualScheduler implements Scheduler {
  fired = 0;
  handler: (() => void) | null = null;
  setInterval(handler: () => void): NodeJS.Timeout | number {
    this.handler = handler;
    return 1 as unknown as NodeJS.Timeout;
  }
  clearInterval(): void {
    this.handler = null;
  }
  trigger(): void {
    this.fired++;
    this.handler?.();
  }
}

function tmpSpool() {
  const dir = mkdtempSync(join(tmpdir(), 'syn-tel-client-'));
  const file = join(dir, 'spool.ndjson');
  return {
    spool: new DiskSpool({ filePath: file, capBytes: 10 * 1024 * 1024 }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeClient(
  overrides: Partial<TelemetryClientOptions> = {},
): { client: TelemetryClient; cleanup: () => void; scheduler: ManualScheduler; spool: DiskSpool; fetchMock: jest.Mock } {
  const { spool, cleanup } = tmpSpool();
  const scheduler = new ManualScheduler();
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ accepted: 1, dropped: 0, results: [] }),
  });
  (globalThis as { fetch: jest.Mock }).fetch = fetchMock;

  const client = new TelemetryClient(null, {
    peerId: 'peer_test',
    appVersion: '0.7.3',
    coordinatorUrl: 'http://coord.test',
    hwFingerprint: HW,
    buildAuthHeaders: async () => ({
      'X-Peer-Id': 'peer_test',
      'X-Public-Key': 'k',
      'X-Timestamp': '1',
      'X-Signature': 's',
    }),
    diskSpool: spool,
    scheduler,
    disableLoggerTap: true,
    ...overrides,
  });
  return { client, cleanup, scheduler, spool, fetchMock };
}

describe('TelemetryClient.emit', () => {
  it('pushes events onto the in-memory ring', () => {
    const { client, cleanup } = makeClient();
    try {
      client.emit(makeBootEvent(HW, { pid: 1, uptime: 0 }));
      expect(client.ringSize()).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('still accepts events with oversized message — sanitizer truncates', () => {
    const { client, cleanup } = makeClient();
    try {
      const huge: TelemetryEventInput = {
        ...makeBootEvent(HW, { pid: 1, uptime: 0 }),
        // Sanitizer truncates message to 2 KB; the event lands in the ring.
        message: 'x'.repeat(200_000),
      };
      client.emit(huge);
      expect(client.ringSize()).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('spills oldest 100 events to disk on overflow', () => {
    const { client, spool, cleanup } = makeClient();
    try {
      for (let i = 0; i < 1100; i++) {
        client.emit(makeBootEvent(HW, { pid: i, uptime: 0 }));
      }
      // After overflow: ring drops to ~ 1000 - 100 + (1100-1000) = 1000
      expect(client.ringSize()).toBeLessThanOrEqual(1000);
      // Some events should have been spilled to disk.
      expect(spool.size()).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});

describe('TelemetryClient.flush', () => {
  it('POSTs the ring contents and clears the buffer on success', async () => {
    const { client, fetchMock, cleanup } = makeClient();
    try {
      client.emit(makeBootEvent(HW, { pid: 1, uptime: 0 }));
      const accepted = await client.flush();
      expect(accepted).toBeGreaterThan(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain('/telemetry/events');
      expect(client.ringSize()).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('drains spool head into the same batch', async () => {
    const { client, spool, cleanup, fetchMock } = makeClient();
    try {
      // Pre-load 5 events into the spool
      spool.appendEvents(
        Array.from({ length: 5 }, (_, i) =>
          makeBootEvent(HW, { pid: i, uptime: 0 }),
        ),
      );
      await client.flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.events.length).toBe(5);
    } finally {
      cleanup();
    }
  });

  it('returns 0 when nothing to flush', async () => {
    const { client, cleanup } = makeClient();
    try {
      const accepted = await client.flush();
      expect(accepted).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('re-queues the batch on transient failure (no retries exhausted)', async () => {
    const { client, fetchMock, cleanup } = makeClient();
    try {
      // Force network failure for ALL retries by rejecting every call
      fetchMock.mockRejectedValue(new Error('network down'));
      client.emit(makeBootEvent(HW, { pid: 1, uptime: 0 }));
      const accepted = await client.flush();
      expect(accepted).toBe(0);
      // First failure -> back into the ring (not yet 3 consecutive failures)
      expect(client.ringSize()).toBe(1);
    } finally {
      cleanup();
    }
  }, 60_000);

  it('moves the batch to disk-spool after MAX_FAILURES_BEFORE_SPOOL', async () => {
    const { client, spool, fetchMock, cleanup } = makeClient();
    try {
      fetchMock.mockRejectedValue(new Error('network down'));
      client.emit(makeBootEvent(HW, { pid: 1, uptime: 0 }));

      // Three consecutive failed flushes
      await client.flush();
      await client.flush();
      await client.flush();

      // After 3 failures, the batch ends up in disk spool, not the ring
      expect(spool.size()).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  }, 240_000);
});

describe('TelemetryClient.start / stop', () => {
  it('start enables the auto-attached logger tap (when not disabled)', async () => {
    const { client, fetchMock, cleanup } = makeClient({
      disableLoggerTap: false,
    });
    try {
      client.start();
      logger.error('[Embedding] failed to embed');
      // The tap synchronously enqueues the event onto the ring
      expect(client.ringSize()).toBe(1);
      client.stop();
      // After stop, new logs do not enqueue
      logger.error('[P2P] should not be tapped');
      expect(client.ringSize()).toBe(1);
    } finally {
      cleanup();
      // Reset shared global tap to avoid bleed into other tests
      // (logger.ts setLoggerTap(null) is called by stop())
    }
    // fetchMock not invoked during this test — flush wasn't triggered
    // (threshold is 50, we only emitted 1).
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flush is auto-triggered when ring crosses FLUSH_THRESHOLD', async () => {
    const { client, fetchMock, cleanup } = makeClient();
    try {
      // Push 50 events — at threshold the client schedules an immediate flush.
      for (let i = 0; i < 50; i++) {
        client.emit(makeBootEvent(HW, { pid: i, uptime: 0 }));
      }
      // Allow the void flush() to settle
      await new Promise(r => setImmediate(r));
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});

describe('TelemetryClient.drainAll', () => {
  it('flushes everything in the ring within the timeout', async () => {
    const { client, fetchMock, cleanup } = makeClient();
    try {
      for (let i = 0; i < 5; i++) {
        client.emit(makeBootEvent(HW, { pid: i, uptime: 0 }));
      }
      await client.drainAll(5_000);
      expect(fetchMock).toHaveBeenCalled();
      expect(client.ringSize()).toBe(0);
    } finally {
      cleanup();
    }
  });
});
