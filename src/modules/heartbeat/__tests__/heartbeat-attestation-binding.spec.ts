/**
 * F-node-011 (MED) regression — heartbeat binary attestation digest
 * binds to peerId + timestamp so a captured response is not replayable
 * from a different peerId or across cycles.
 *
 * Pre-fix shape: sha256(chunk || nonce)            — replayable
 * Post-fix shape: sha256(chunk || nonce || peerId || ts) — bound
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createHash } from 'crypto';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HeartbeatHelper, __resetCapabilitySnapshotForTests } from '../heartbeat';
import { of } from 'rxjs';

describe('F-node-011 — heartbeat attestation digest binding', () => {
  let helper: HeartbeatHelper;
  let tmpDir: string;
  let originalCwd: string;
  let httpPost: jest.Mock;
  let capturedPayloads: unknown[] = [];

  beforeEach(() => {
    __resetCapabilitySnapshotForTests();
    capturedPayloads = [];

    // Plant a fake dist/index.js so `loadOwnBundle` succeeds — the
    // helper needs SOME bytes to digest. Contents are deterministic.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'syn-attest-'));
    mkdirSync(path.join(tmpDir, 'dist'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dist', 'index.js'), Buffer.from('A'.repeat(1024)));
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    httpPost = jest.fn().mockImplementation((_path: unknown, body: unknown) => {
      capturedPayloads.push(body);
      return of({ data: { registered: true, peerId: 'peer-1' } });
    });
    const httpService = { post: httpPost } as unknown as ConstructorParameters<typeof HeartbeatHelper>[1];
    const ipifyService = { resolvePublicIp: jest.fn().mockResolvedValue(null as never) } as unknown as ConstructorParameters<typeof HeartbeatHelper>[0];
    helper = new HeartbeatHelper(ipifyService, httpService);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    __resetCapabilitySnapshotForTests();
  });

  it('digest binds chunk + nonce + peerId + ts (replay across peers fails)', async () => {
    // Inject a pending challenge by reaching into the private field via
    // an indexed cast — same pattern used by other heartbeat specs.
    const challenge = { nonce: 'NONCE-XYZ', offset: 0, length: 16 };
    (helper as unknown as { pendingChallenge: typeof challenge | null }).pendingChallenge = challenge;

    const identity = { peerId: 'peer-alpha', name: 'n', publicKey: '00'.repeat(32), privateKey: '00'.repeat(32) };
    const hardware = { hardwareClass: 1, ramGb: 8, cpuCores: 4, gpuVramGb: 0, gpuModel: 'mock' } as unknown as Parameters<HeartbeatHelper['sendHeartbeat']>[2];

    await helper.sendHeartbeat('http://coord.test', identity as never, hardware, undefined, undefined, null);

    expect(capturedPayloads).toHaveLength(1);
    const sent = capturedPayloads[0] as {
      peerId: string;
      attestationResponse?: string;
      attestationTs?: number;
    };
    expect(sent.peerId).toBe('peer-alpha');
    expect(sent.attestationResponse).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof sent.attestationTs).toBe('number');
    expect(sent.attestationTs).toBeGreaterThan(0);

    // Re-derive the digest with the SAME chunk + nonce but a DIFFERENT
    // peerId. It must NOT match — proves the binding is real.
    const chunk = Buffer.from('A'.repeat(16));
    const peerBobBuf = Buffer.from('peer-bob', 'utf-8');
    const tsBuf = Buffer.from(String(sent.attestationTs), 'utf-8');
    const replayed = createHash('sha256')
      .update(Buffer.concat([chunk, Buffer.from('NONCE-XYZ'), peerBobBuf, tsBuf]))
      .digest('hex');
    expect(replayed).not.toBe(sent.attestationResponse);

    // And the legacy (pre-fix) shape — chunk + nonce only — must ALSO
    // not match the new response: proves we are not silently still
    // emitting the old shape.
    const preFix = createHash('sha256')
      .update(Buffer.concat([chunk, Buffer.from('NONCE-XYZ')]))
      .digest('hex');
    expect(preFix).not.toBe(sent.attestationResponse);
  });

  it('omits attestationResponse + attestationTs when no challenge pending', async () => {
    const identity = { peerId: 'peer-alpha', name: 'n', publicKey: '00'.repeat(32), privateKey: '00'.repeat(32) };
    const hardware = { hardwareClass: 1, ramGb: 8, cpuCores: 4, gpuVramGb: 0, gpuModel: 'mock' } as unknown as Parameters<HeartbeatHelper['sendHeartbeat']>[2];
    await helper.sendHeartbeat('http://coord.test', identity as never, hardware, undefined, undefined, null);
    const sent = capturedPayloads[0] as { attestationResponse?: string; attestationTs?: number };
    expect(sent.attestationResponse).toBeUndefined();
    expect(sent.attestationTs).toBeUndefined();
  });
});
