/**
 * Bug 41 (BLOCKER) — P2P publishHeartbeat path inverted peerId / p2pPeerId.
 *
 * Pre-fix (heartbeat.ts:1552-1561):
 *   peerId: p2pNode.getPeerId(),   // libp2p form — WRONG
 *   p2pPeerId: identity.peerId,    // Ed25519 hex — WRONG
 *
 * HTTP path (heartbeat.ts:849-851) — CORRECT, the canonical shape coord
 * stores in the `peers` Redis hash:
 *   peerId: identity.peerId,                                  // Ed25519 hex
 *   p2pPeerId: this.p2pNode?.getPeerId() ?? identity.peerId,  // libp2p
 *
 * Symptom: coord-side observed 2 peer records per physical node — one keyed
 * by libp2p form (12D3KooW…), another by Ed25519 hex (be06bff…). Coord
 * trusts `data.peerId` as-is → 2 distinct Redis hashes per node.
 *
 * Contract under test (post-fix):
 *   1. P2P branch invokes `p2pNode.publishHeartbeat(dto)` with
 *      `dto.peerId === identity.peerId` (Ed25519 hex form).
 *   2. `dto.p2pPeerId === p2pNode.getPeerId()` (libp2p form).
 *   3. Shape matches the HTTP heartbeat shape per line 849-851.
 *   4. P9 fail-closed: when `p2pNode.getPeerId()` returns `undefined`, the
 *      dto falls back to `identity.peerId` for `p2pPeerId` (never publish
 *      `undefined`).
 *
 * Test surface: drives the real `startPeriodicHeartbeat` loop with stubbed
 * P2PNode + stubbed `sendHeartbeat`, kicks the first tick on a fake timer,
 * and asserts on the dto that was passed to `p2pNode.publishHeartbeat`.
 * Real flow exercise (P29) — not just mock-assert on shape.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { HeartbeatHelper } from '../heartbeat';
import type { Identity } from '../../identity/identity';
import type { Hardware } from '../../hardware/hardware';
import type { P2PNode } from '../../p2p/p2p';

// Mock the docking module so any side-effect probe stays inert.
jest.mock('../../docking', () => ({
  isVinaAvailable: jest.fn().mockResolvedValue(false),
  __resetVinaCacheForTests: jest.fn(),
  runDocking: jest.fn(),
  assertBinariesAvailable: jest.fn(),
  parseVinaPdbqt: jest.fn(),
  DockingError: class DockingError extends Error {},
}));

// Mock ModelDiscovery so the loop doesn't try to talk to ollama.
jest.mock('../../discovery/model-discovery', () => ({
  ModelDiscovery: class {
    async registerModels() {
      return;
    }
  },
}));

const ED25519_PEER_ID = 'be06bff1d2c3a4b5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d';
const LIBP2P_PEER_ID = '12D3KooWBxL3Hq7N9pQrSt6UvWxYz1A2B3C4D5E6F7G8H9I0J1K2';

function makeIdentity(): Identity {
  return {
    peerId: ED25519_PEER_ID,
    publicKey: ED25519_PEER_ID, // identical hex shape for the test
    privateKey: '00'.repeat(32),
    createdAt: Date.now(),
    name: 'node-test',
  };
}

function makeHardware(): Hardware {
  return {
    cpuCores: 8,
    ramGb: 16,
    gpuVramGb: 0,
    gpuModel: 'Apple M1',
    hardwareClass: 2,
    hasOllama: false,
  };
}

interface StubP2PNode {
  isRunning: jest.Mock<() => boolean>;
  getPeerId: jest.Mock<() => string | undefined>;
  publishHeartbeat: jest.Mock<(data: Record<string, unknown>) => Promise<void>>;
}

function makeP2PNodeStub(opts: { getPeerId?: () => string | undefined } = {}): StubP2PNode {
  return {
    isRunning: jest.fn(() => true) as unknown as jest.Mock<() => boolean>,
    getPeerId: jest.fn(opts.getPeerId ?? (() => LIBP2P_PEER_ID)) as unknown as jest.Mock<
      () => string | undefined
    >,
    publishHeartbeat: jest.fn(async () => undefined) as unknown as jest.Mock<
      (data: Record<string, unknown>) => Promise<void>
    >,
  };
}

describe('HeartbeatHelper.startPeriodicHeartbeat — P2P publishHeartbeat shape (Bug 41)', () => {
  let helper: HeartbeatHelper;
  let cancel: (() => void) | null = null;

  beforeEach(() => {
    helper = new HeartbeatHelper({ resolvePublicIp: jest.fn().mockResolvedValue(null) } as any);
    // Stub the HTTP heartbeat so the loop doesn't try to hit a real coord.
    jest.spyOn(helper, 'sendHeartbeat').mockResolvedValue(undefined as unknown as void);
    // Skip heavy capability probes — they spawn python3 and would block
    // the test on real I/O. The bug under test lives in the dto-field
    // assembly, not capability resolution.
    jest
      .spyOn(helper, 'determineCapabilitiesAsync')
      .mockResolvedValue(['cpu_inference', 'inference']);
  });

  afterEach(async () => {
    if (cancel) {
      cancel();
      cancel = null;
    }
    jest.restoreAllMocks();
  });

  async function runOneTick(p2p: StubP2PNode): Promise<void> {
    // Use a tiny real interval so the first tick fires immediately and
    // we can await on `publishHeartbeat` resolution without juggling
    // fake-timer / microtask interleaving. The loop schedules its first
    // tick on setTimeout(0) regardless of interval.
    cancel = helper.startPeriodicHeartbeat(
      'http://coord.local',
      makeIdentity(),
      makeHardware(),
      60_000,
      p2p as unknown as P2PNode,
      0,
      0,
      null,
      undefined,
    );
    // Poll for up to 2s for the first publishHeartbeat call.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (p2p.publishHeartbeat.mock.calls.length > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('emits dto with peerId=identity.peerId (Ed25519 hex) and p2pPeerId=p2pNode.getPeerId() (libp2p form)', async () => {
    const p2p = makeP2PNodeStub();
    await runOneTick(p2p);

    expect(p2p.publishHeartbeat).toHaveBeenCalledTimes(1);
    const dto = p2p.publishHeartbeat.mock.calls[0]![0] as Record<string, unknown>;

    // Core invariant: peerId is the Ed25519 hex (NOT the libp2p form).
    expect(dto.peerId).toBe(ED25519_PEER_ID);
    // p2pPeerId is the libp2p form.
    expect(dto.p2pPeerId).toBe(LIBP2P_PEER_ID);
    // Explicit non-inversion guard.
    expect(dto.peerId).not.toBe(LIBP2P_PEER_ID);
    expect(dto.p2pPeerId).not.toBe(ED25519_PEER_ID);
  });

  it('mirrors HTTP heartbeat shape (peerId / p2pPeerId / name / walletAddress / hardwareClass / capabilities)', async () => {
    const p2p = makeP2PNodeStub();
    await runOneTick(p2p);

    const dto = p2p.publishHeartbeat.mock.calls[0]![0] as Record<string, unknown>;
    expect(dto).toMatchObject({
      peerId: ED25519_PEER_ID,
      p2pPeerId: LIBP2P_PEER_ID,
      name: 'node-test',
      walletAddress: null,
      hardwareClass: 2,
    });
    expect(Array.isArray(dto.capabilities)).toBe(true);
    expect(typeof dto.uptime).toBe('number');
    expect(typeof dto.timestamp).toBe('number');
  });

  it('P9 fail-closed: when p2pNode.getPeerId() returns undefined, p2pPeerId falls back to identity.peerId (never undefined)', async () => {
    const p2p = makeP2PNodeStub({ getPeerId: () => undefined });
    await runOneTick(p2p);

    expect(p2p.publishHeartbeat).toHaveBeenCalledTimes(1);
    const dto = p2p.publishHeartbeat.mock.calls[0]![0] as Record<string, unknown>;

    // peerId still wired to Ed25519 hex — no inversion regression.
    expect(dto.peerId).toBe(ED25519_PEER_ID);
    // p2pPeerId falls back to Ed25519 hex (safer than publishing undefined).
    expect(dto.p2pPeerId).toBe(ED25519_PEER_ID);
    expect(dto.p2pPeerId).not.toBeUndefined();
  });
});
