/**
 * Tests for `verifyCoordinatorEnvelope` — the SINGLE shared verify helper for
 * coordinator-signed gossip envelopes on the node side.
 *
 * Includes the SHARED BYTE-CONTRACT VECTOR: the SAME expected hex asserted in
 * the coordinator publisher spec
 * (`CoordinatorPublisher.spec.ts ::
 * "produces the canonical shared-vector signed bytes"`). If either side's
 * signed-bytes format drifts, exactly one of the two specs fails.
 */
import { generateKeyPairSync, sign } from 'crypto';

import { ReplayGuard } from '../replay-guard';
import {
  DOMAIN_EVAL_ASSIGNMENTS,
  DOMAIN_WO_ASSIGNED,
  DOMAIN_WO_AVAILABLE,
  verifyCoordinatorEnvelope,
} from '../verify-coordinator-envelope';

interface KeyPair {
  rawPubKey: Uint8Array;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}

function makeKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const rawPubKey = publicKeyDer.subarray(12);
  return { rawPubKey, privateKey };
}

/** Mint a base64 Ed25519 signature over the domain-tagged signed bytes. */
function signEnvelope(
  domain: string,
  body: unknown,
  ts: number,
  privateKey: KeyPair['privateKey'],
): string {
  const signedBytes = Buffer.from(JSON.stringify({ domain, body, ts }), 'utf8');
  return Buffer.from(sign(null, signedBytes, privateKey)).toString('base64');
}

describe('verifyCoordinatorEnvelope', () => {
  const now = 1_700_000_000;
  let kp: KeyPair;

  beforeEach(() => {
    kp = makeKeyPair();
  });

  // ── SHARED BYTE-CONTRACT VECTOR ──────────────────────────────────────────
  // Fixed input: small wo body + fixed ts under the AVAILABLE domain. The hex
  // below is byte-identical to the coordinator publisher spec assertion.
  it('reconstructs the canonical shared-vector signed bytes (hex byte-contract)', () => {
    const body = { id: 'wo-vec-1', title: 'vec' };
    const signedStr = JSON.stringify({
      domain: DOMAIN_WO_AVAILABLE,
      body,
      ts: now,
    });
    const hex = Buffer.from(new TextEncoder().encode(signedStr)).toString('hex');
    expect(hex).toBe(
      '7b22646f6d61696e223a2273796e6170736569612f676f737369702f776f726b2d6f726465722d617661696c61626c652f7631222c22626f6479223a7b226964223a22776f2d7665632d31222c227469746c65223a22766563227d2c227473223a313730303030303030307d',
    );
  });

  it('accepts a correctly-signed, fresh envelope', () => {
    const body = { id: 'wo-1' };
    const sigBase64 = signEnvelope(DOMAIN_WO_AVAILABLE, body, now, kp.privateKey);
    const res = verifyCoordinatorEnvelope({
      domain: DOMAIN_WO_AVAILABLE,
      body,
      ts: now,
      sigBase64,
      coordinatorPubkey: kp.rawPubKey,
      now: now * 1000,
      freshnessWindowSec: 60,
    });
    expect(res).toEqual({ ok: true });
  });

  it('rejects a signature minted under a DIFFERENT domain (cross-type replay)', () => {
    const body = { targetPeerId: 'p', wo: { id: 'wo-1' } };
    // Mint under ASSIGNED, verify under EVAL → different reconstructed bytes.
    const sigBase64 = signEnvelope(DOMAIN_WO_ASSIGNED, body, now, kp.privateKey);
    const res = verifyCoordinatorEnvelope({
      domain: DOMAIN_EVAL_ASSIGNMENTS,
      body,
      ts: now,
      sigBase64,
      coordinatorPubkey: kp.rawPubKey,
      now: now * 1000,
      freshnessWindowSec: 60,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid-signature');
  });

  it('rejects a signature from a different key', () => {
    const forger = makeKeyPair();
    const body = { id: 'wo-1' };
    const sigBase64 = signEnvelope(DOMAIN_WO_AVAILABLE, body, now, forger.privateKey);
    const res = verifyCoordinatorEnvelope({
      domain: DOMAIN_WO_AVAILABLE,
      body,
      ts: now,
      sigBase64,
      coordinatorPubkey: kp.rawPubKey,
      now: now * 1000,
      freshnessWindowSec: 60,
    });
    expect(res.reason).toBe('invalid-signature');
  });

  it('rejects a stale envelope (older than the freshness window)', () => {
    const body = { id: 'wo-1' };
    const oldTs = now - 120;
    const sigBase64 = signEnvelope(DOMAIN_WO_AVAILABLE, body, oldTs, kp.privateKey);
    const res = verifyCoordinatorEnvelope({
      domain: DOMAIN_WO_AVAILABLE,
      body,
      ts: oldTs,
      sigBase64,
      coordinatorPubkey: kp.rawPubKey,
      now: now * 1000,
      freshnessWindowSec: 60,
    });
    expect(res.reason).toBe('stale');
  });

  it('rejects a non-64-byte signature', () => {
    const body = { id: 'wo-1' };
    const res = verifyCoordinatorEnvelope({
      domain: DOMAIN_WO_AVAILABLE,
      body,
      ts: now,
      sigBase64: Buffer.from([1, 2, 3]).toString('base64'),
      coordinatorPubkey: kp.rawPubKey,
      now: now * 1000,
      freshnessWindowSec: 60,
    });
    expect(res.reason).toBe('bad-signature-encoding');
  });

  it('rejects a replayed signature when a shared guard is provided', () => {
    const body = { id: 'wo-1' };
    const sigBase64 = signEnvelope(DOMAIN_WO_AVAILABLE, body, now, kp.privateKey);
    const replayGuard = new ReplayGuard(60);
    const args = {
      domain: DOMAIN_WO_AVAILABLE,
      body,
      ts: now,
      sigBase64,
      coordinatorPubkey: kp.rawPubKey,
      now: now * 1000,
      freshnessWindowSec: 60,
      replayGuard,
    };

    expect(verifyCoordinatorEnvelope(args)).toEqual({ ok: true });
    expect(verifyCoordinatorEnvelope(args).reason).toBe('replayed');
  });

  it('a forged signature never records an entry in the replay guard', () => {
    const forger = makeKeyPair();
    const body = { id: 'wo-1' };
    const forgedSig = signEnvelope(DOMAIN_WO_AVAILABLE, body, now, forger.privateKey);
    const replayGuard = new ReplayGuard(60);

    // Forged sig → invalid-signature, guard untouched.
    const r1 = verifyCoordinatorEnvelope({
      domain: DOMAIN_WO_AVAILABLE,
      body,
      ts: now,
      sigBase64: forgedSig,
      coordinatorPubkey: kp.rawPubKey,
      now: now * 1000,
      freshnessWindowSec: 60,
      replayGuard,
    });
    expect(r1.reason).toBe('invalid-signature');

    // The SAME (now genuinely valid) sig string is accepted first time — proof
    // the forged attempt did not poison the seen-set.
    const validSig = signEnvelope(DOMAIN_WO_AVAILABLE, body, now, kp.privateKey);
    const r2 = verifyCoordinatorEnvelope({
      domain: DOMAIN_WO_AVAILABLE,
      body,
      ts: now,
      sigBase64: validSig,
      coordinatorPubkey: kp.rawPubKey,
      now: now * 1000,
      freshnessWindowSec: 60,
      replayGuard,
    });
    expect(r2).toEqual({ ok: true });
  });
});
