/**
 * Plan D.4-distribution.5 — verifier + producer specs for the
 * `KG_SHARD_SNAPSHOT_READY` topic. Real Ed25519 keys + signatures
 * exercise the verifier; tampered envelopes really fail the verify
 * step (not stub-equality).
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { generateIdentity, type Identity, sign as ed25519Sign } from '../../../modules/identity/identity';
import { canonicalJson } from '../../protocols/kg-shard-envelope';
import { KgShardHintStore } from '../../kg-shard/KgShardHintStore';
import {
  handleKgShardSnapshotReady,
  publishShardReady,
  type ShardReadyBody,
  type ShardReadySignedEnvelope,
} from '../kg-shard-snapshot-ready';

async function buildEnvelope(
  signer: Identity,
  body: ShardReadyBody,
  publishedAt = Date.now(),
): Promise<Uint8Array> {
  const canonical = canonicalJson({ body, publishedAt });
  const signature = await ed25519Sign(canonical, signer.privateKey);
  const env: ShardReadySignedEnvelope = {
    body,
    publishedAt,
    signedBy: 'node_self',
    signature,
  };
  return new TextEncoder().encode(JSON.stringify(env));
}

describe('handleKgShardSnapshotReady', () => {
  let tmpDir: string;
  let myIdentity: Identity;
  let theirIdentity: Identity;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'shard-ready-test-'));
    myIdentity = generateIdentity(tmpDir + '/me', 'me');
    theirIdentity = generateIdentity(tmpDir + '/them', 'them');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('valid envelope adds the announcer to the hint store for the shard', async () => {
    const hints = new KgShardHintStore();
    const body: ShardReadyBody = {
      peerId: theirIdentity.peerId,
      pubkeyHex: theirIdentity.publicKey,
      shardId: 3,
      recordsHeld: 42,
      publishedAtMs: Date.now(),
    };
    const msg = await buildEnvelope(theirIdentity, body);
    await handleKgShardSnapshotReady({
      msg,
      hints,
      thisPeerId: myIdentity.peerId,
    });
    expect(hints.hintsFor(3)).toEqual([theirIdentity.peerId]);
  });

  it('rejects an envelope where pubkeyHex does not start with peerId', async () => {
    const hints = new KgShardHintStore();
    const body: ShardReadyBody = {
      peerId: theirIdentity.peerId,
      pubkeyHex: myIdentity.publicKey, // mismatched pubkey
      shardId: 3,
      recordsHeld: 42,
      publishedAtMs: Date.now(),
    };
    const warns: string[] = [];
    const msg = await buildEnvelope(theirIdentity, body);
    await handleKgShardSnapshotReady({
      msg,
      hints,
      thisPeerId: myIdentity.peerId,
      warn: (m) => warns.push(m),
    });
    expect(hints.hintsFor(3)).toEqual([]);
    expect(warns.some((m) => m.includes('pubkey/peerId mismatch'))).toBe(true);
  });

  it('rejects an envelope with a stale publishedAt', async () => {
    const hints = new KgShardHintStore();
    const body: ShardReadyBody = {
      peerId: theirIdentity.peerId,
      pubkeyHex: theirIdentity.publicKey,
      shardId: 3,
      recordsHeld: 42,
      publishedAtMs: Date.now() - 60 * 60 * 1000, // 1h stale
    };
    const msg = await buildEnvelope(theirIdentity, body, body.publishedAtMs);
    const warns: string[] = [];
    await handleKgShardSnapshotReady({
      msg,
      hints,
      thisPeerId: myIdentity.peerId,
      warn: (m) => warns.push(m),
    });
    expect(hints.hintsFor(3)).toEqual([]);
    expect(warns.some((m) => m.includes('out of bounds'))).toBe(true);
  });

  it('rejects an envelope with a forged signature (different signer)', async () => {
    const hints = new KgShardHintStore();
    const body: ShardReadyBody = {
      peerId: theirIdentity.peerId,
      pubkeyHex: theirIdentity.publicKey,
      shardId: 3,
      recordsHeld: 42,
      publishedAtMs: Date.now(),
    };
    // Sign with `myIdentity` even though body.peerId belongs to theirs.
    const msg = await buildEnvelope(myIdentity, body);
    const warns: string[] = [];
    await handleKgShardSnapshotReady({
      msg,
      hints,
      thisPeerId: 'someone-else',
      warn: (m) => warns.push(m),
    });
    expect(hints.hintsFor(3)).toEqual([]);
    expect(warns.some((m) => m.includes('verify failed'))).toBe(true);
  });

  it('ignores envelopes from this node itself (no self-hint)', async () => {
    const hints = new KgShardHintStore();
    const body: ShardReadyBody = {
      peerId: myIdentity.peerId,
      pubkeyHex: myIdentity.publicKey,
      shardId: 3,
      recordsHeld: 42,
      publishedAtMs: Date.now(),
    };
    const msg = await buildEnvelope(myIdentity, body);
    await handleKgShardSnapshotReady({
      msg,
      hints,
      thisPeerId: myIdentity.peerId,
    });
    expect(hints.hintsFor(3)).toEqual([]);
  });

  it('rejects an envelope missing required body fields', async () => {
    const hints = new KgShardHintStore();
    const partial = { foo: 'bar' };
    const publishedAt = Date.now();
    const canonical = canonicalJson({ body: partial, publishedAt });
    const signature = await ed25519Sign(canonical, theirIdentity.privateKey);
    const env = {
      body: partial,
      publishedAt,
      signedBy: 'node_self',
      signature,
    };
    const msg = new TextEncoder().encode(JSON.stringify(env));
    const warns: string[] = [];
    await handleKgShardSnapshotReady({
      msg,
      hints,
      thisPeerId: myIdentity.peerId,
      warn: (m) => warns.push(m),
    });
    expect(hints.hintsFor(3)).toEqual([]);
    expect(warns.some((m) => m.includes('missing required fields'))).toBe(true);
  });
});

describe('publishShardReady', () => {
  let tmpDir: string;
  let myIdentity: Identity;
  let theirIdentity: Identity;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'shard-ready-pub-test-'));
    myIdentity = generateIdentity(tmpDir + '/me', 'me');
    theirIdentity = generateIdentity(tmpDir + '/them', 'them');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('signs + publishes a well-formed envelope on the configured topic', async () => {
    const calls: Array<{ topic: string; payload: any }> = [];
    await publishShardReady({
      identity: myIdentity,
      shardId: 7,
      recordsHeld: 100,
      publish: async (topic, payload) => { calls.push({ topic, payload }); },
      topic: '/synapseia/kg-shard-snapshot-ready/1.0.0',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].topic).toBe('/synapseia/kg-shard-snapshot-ready/1.0.0');
    const env = calls[0].payload as ShardReadySignedEnvelope;
    expect(env.signedBy).toBe('node_self');
    expect(env.signature).toMatch(/^[0-9a-f]+$/);
    expect(env.signature.length).toBe(128);
    expect(env.body.peerId).toBe(myIdentity.peerId);
    expect(env.body.pubkeyHex).toBe(myIdentity.publicKey);
    expect(env.body.shardId).toBe(7);
    expect(env.body.recordsHeld).toBe(100);
  });

  it('round-trips through handleKgShardSnapshotReady on a fresh hint store', async () => {
    const hints = new KgShardHintStore();
    const calls: any[] = [];
    await publishShardReady({
      identity: theirIdentity,
      shardId: 11,
      recordsHeld: 5,
      publish: async (_t, payload) => { calls.push(payload); },
      topic: 'topic',
    });
    const msg = new TextEncoder().encode(JSON.stringify(calls[0]));
    await handleKgShardSnapshotReady({
      msg,
      hints,
      thisPeerId: myIdentity.peerId,
    });
    expect(hints.hintsFor(11)).toEqual([theirIdentity.peerId]);
  });
});
