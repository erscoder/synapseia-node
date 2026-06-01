/**
 * Unit spec for `stopRunningNode` — the control flow behind `synapseia stop`.
 *
 * This exercises the REAL method under test (signal + poll loop), driving its
 * injectable seams (`kill`, `sleep`, `readLock`, `clearLock`) deterministically
 * rather than stubbing the action away. The bug this guards against: the old
 * `stop` never read the lock nor signalled the daemon, so a daemon survived
 * `synapseia stop`. These tests assert the SIGTERM is sent to the lock PID and
 * that "stopped" is only reported after the PID is poll-confirmed gone (P22).
 */
import { describe, it, expect, jest } from '@jest/globals';

import {
  stopRunningNode,
  type NodeLockInfo,
  type StopDeps,
} from '../node-lock';

const baseLock: NodeLockInfo = {
  pid: 69222,
  startedAt: '2026-05-31T10:00:00.000Z',
  source: 'cli',
};

/** ESRCH error builder (process not found). */
function esrch(): NodeJS.ErrnoException {
  const e = new Error('kill ESRCH') as NodeJS.ErrnoException;
  e.code = 'ESRCH';
  return e;
}

describe('stopRunningNode', () => {
  it('sends SIGTERM to the lock PID, polls, reports stopped, clears the lock', async () => {
    const logs: string[] = [];
    const clearLock = jest.fn();
    // Alive on the first N probes (signal-0), then dead. The first kill call is
    // the real SIGTERM; subsequent kill(pid, 0) calls are liveness polls.
    let probeCount = 0;
    const kill = jest.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) {
        probeCount += 1;
        // First poll: still alive. Second poll: dead → throw ESRCH.
        if (probeCount >= 2) throw esrch();
        return;
      }
      // SIGTERM: succeeds (daemon receives it).
    });

    const deps: StopDeps = {
      kill,
      sleep: jest.fn(async () => undefined),
      log: (m) => logs.push(m),
      readLock: () => ({ ...baseLock }),
      clearLock,
      graceMs: 10_000,
      pollMs: 250,
    };

    const result = await stopRunningNode(deps);

    expect(result.outcome).toBe('stopped');
    expect(result.pid).toBe(69222);
    // SIGTERM was sent to the lock PID.
    expect(kill).toHaveBeenCalledWith(69222, 'SIGTERM');
    // The initial probe before SIGTERM also targeted the lock PID with signal 0.
    expect(kill).toHaveBeenCalledWith(69222, 0);
    // Lock cleared after confirmed exit.
    expect(clearLock).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('✅ Node (pid 69222) stopped.'))).toBe(true);
  });

  it('clears a stale lock without signalling when the PID is dead', async () => {
    const logs: string[] = [];
    const clearLock = jest.fn();
    // probe(0) throws ESRCH → not alive.
    const kill = jest.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) throw esrch();
      throw new Error('SIGTERM must never be sent to a dead PID');
    });

    const result = await stopRunningNode({
      kill,
      sleep: jest.fn(async () => undefined),
      log: (m) => logs.push(m),
      readLock: () => ({ ...baseLock }),
      clearLock,
    });

    expect(result.outcome).toBe('stale');
    // No SIGTERM ever sent.
    expect(kill).not.toHaveBeenCalledWith(69222, 'SIGTERM');
    expect(clearLock).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('stale lock'))).toBe(true);
  });

  it('reports no-lock and signals nothing when there is no lock file', async () => {
    const logs: string[] = [];
    const kill = jest.fn();
    const clearLock = jest.fn();

    const result = await stopRunningNode({
      kill,
      sleep: jest.fn(async () => undefined),
      log: (m) => logs.push(m),
      readLock: () => null,
      clearLock,
    });

    expect(result.outcome).toBe('no-lock');
    expect(kill).not.toHaveBeenCalled();
    expect(clearLock).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('No running node found (no lock file).'))).toBe(true);
  });

  it('reports timeout WITHOUT SIGKILL when the daemon never exits', async () => {
    const logs: string[] = [];
    const clearLock = jest.fn();
    // Always alive: SIGTERM succeeds, every probe(0) returns (alive).
    const kill = jest.fn((_pid: number, _signal: NodeJS.Signals | 0) => {
      // never throws → always alive
    });

    const result = await stopRunningNode({
      kill,
      sleep: jest.fn(async () => undefined),
      log: (m) => logs.push(m),
      readLock: () => ({ ...baseLock }),
      clearLock,
      graceMs: 1000,
      pollMs: 250,
    });

    expect(result.outcome).toBe('timeout');
    // SIGTERM was attempted exactly once; never escalated to SIGKILL.
    expect(kill).toHaveBeenCalledWith(69222, 'SIGTERM');
    expect(kill).not.toHaveBeenCalledWith(69222, 'SIGKILL');
    // Lock NOT cleared on timeout (daemon still owns it).
    expect(clearLock).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('did not exit after SIGTERM'))).toBe(true);
    expect(logs.some((l) => l.includes('kill -9 69222'))).toBe(true);
  });

  it('treats an ESRCH race on SIGTERM as a stale lock (no false "stopped")', async () => {
    const logs: string[] = [];
    const clearLock = jest.fn();
    // probe(0) → alive; SIGTERM → ESRCH (died in the gap).
    const kill = jest.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 'SIGTERM') throw esrch();
      // signal 0 → alive
    });

    const result = await stopRunningNode({
      kill,
      sleep: jest.fn(async () => undefined),
      log: (m) => logs.push(m),
      readLock: () => ({ ...baseLock }),
      clearLock,
    });

    expect(result.outcome).toBe('stale');
    expect(clearLock).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('✅'))).toBe(false);
  });
});
