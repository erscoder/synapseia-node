/**
 * A2A Auth Service Tests
 * Sprint D — A2A Server
 */

import {
  A2AAuthService,
  derivePeerIdFromPublicKey,
  hashPayload,
  canonicalJson,
} from '../auth/a2a-auth.service';
import * as crypto from 'node:crypto';
import type { A2ATask } from '../types';

function generateTestKeypair(): { privateKeyHex: string; publicKeyHex: string; peerId: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privHex = (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).slice(-32).toString('hex');
  const pubHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).slice(-32).toString('hex');
  // peerId = first 32 hex chars of the pubkey (project identity convention).
  return { privateKeyHex: privHex, publicKeyHex: pubHex, peerId: pubHex.slice(0, 32) };
}

describe('A2AAuthService', () => {
  let authService: A2AAuthService;

  beforeEach(() => {
    authService = new A2AAuthService();
  });

  afterEach(() => {
    authService.clearNonces();
  });

  describe('verify', () => {
    // Build a task whose senderPeerId is correctly bound to `peerId`. A real
    // signature is computed via `signTask` using the SAME message format as
    // production (`buildMessage`, which includes the payload hash).
    function makeTask(peerId: string, overrides: Partial<A2ATask> = {}): A2ATask {
      return {
        id: 'task-1',
        type: 'health_check',
        payload: {},
        senderPeerId: peerId,
        timestamp: Date.now(),
        nonce: Math.random().toString(36).slice(2),
        signature: 'abc123',
        ...overrides,
      };
    }

    // Sign using the production message format: id:type:peerId:ts:nonce:sha256(canonical(payload)).
    function signTask(task: Omit<A2ATask, 'signature'>, privateKeyHex: string): A2ATask {
      const message = authService.buildMessage(task);
      const PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');
      const derKey = Buffer.concat([PKCS8_HEADER, Buffer.from(privateKeyHex, 'hex')]);
      const keyObject = crypto.createPrivateKey({ key: derKey, format: 'der', type: 'pkcs8' });
      const sig = crypto.sign(null, Buffer.from(message, 'utf-8'), keyObject).toString('hex');
      return { ...task, signature: sig };
    }

    it('should reject expired requests (timestamp too old)', async () => {
      const { privateKeyHex, publicKeyHex, peerId } = generateTestKeypair();
      const task = signTask(makeTask(peerId, { timestamp: Date.now() - 60_000 }), privateKeyHex);
      const valid = await authService.verify(task, publicKeyHex);
      expect(valid).toBe(false);
    });

    it('should reject future timestamps (clock skew > 5s)', async () => {
      const { privateKeyHex, publicKeyHex, peerId } = generateTestKeypair();
      const task = signTask(makeTask(peerId, { timestamp: Date.now() + 10_000 }), privateKeyHex);
      const valid = await authService.verify(task, publicKeyHex);
      expect(valid).toBe(false);
    });

    it('should reject replay of the same nonce', async () => {
      const { privateKeyHex, publicKeyHex, peerId } = generateTestKeypair();
      const nonce = Math.random().toString(36).slice(2);
      const task = signTask(makeTask(peerId, { nonce }), privateKeyHex);

      // First call should succeed (valid signature + binding)
      const first = await authService.verify(task, publicKeyHex);
      expect(first).toBe(true);

      // Same nonce replayed should fail
      const second = await authService.verify(task, publicKeyHex);
      expect(second).toBe(false);
    });

    it('should reject invalid signatures', async () => {
      const { privateKeyHex, publicKeyHex, peerId } = generateTestKeypair();
      const task = signTask(makeTask(peerId), privateKeyHex);
      // Tamper with signature
      task.signature = 'b'.repeat(128);

      const valid = await authService.verify(task, publicKeyHex);
      expect(valid).toBe(false);
    });

    it('should accept valid Ed25519 signatures', async () => {
      const { privateKeyHex, publicKeyHex, peerId } = generateTestKeypair();
      const task = signTask(makeTask(peerId), privateKeyHex);

      const valid = await authService.verify(task, publicKeyHex);
      expect(valid).toBe(true);
    });

    // FINDING 1 — identity binding. Attacker brings their OWN keypair, signs
    // correctly, but claims a senderPeerId they do not own.
    it('should REJECT when X-Public-Key does not derive to senderPeerId (BYO keypair)', async () => {
      const attacker = generateTestKeypair();
      const victimPeerId = 'deadbeefdeadbeefdeadbeefdeadbeef'; // not the attacker's
      // Attacker signs a task that *claims* the victim peerId, with their own key.
      const task = signTask(makeTask(victimPeerId), attacker.privateKeyHex);

      const valid = await authService.verify(task, attacker.publicKeyHex);
      expect(valid).toBe(false);
    });

    it('should REJECT a malformed (non-64-hex) public key (fail-closed)', async () => {
      const { privateKeyHex, peerId } = generateTestKeypair();
      const task = signTask(makeTask(peerId), privateKeyHex);
      const valid = await authService.verify(task, 'not-a-valid-pubkey');
      expect(valid).toBe(false);
    });

    // FINDING 2 — payload binding. Otherwise-valid signed task with a swapped
    // payload (relay/MITM) must be rejected.
    it('should REJECT a payload-tampered but otherwise-valid signed task', async () => {
      const { privateKeyHex, publicKeyHex, peerId } = generateTestKeypair();
      const task = signTask(
        makeTask(peerId, { payload: { model: 'gpt-trusted', prompt: 'safe' } }),
        privateKeyHex,
      );
      // MITM swaps the payload, signature unchanged.
      task.payload = { model: 'gpt-evil', prompt: 'exfiltrate' };

      const valid = await authService.verify(task, publicKeyHex);
      expect(valid).toBe(false);
    });

    it('should ACCEPT a correctly-bound, payload-signed task', async () => {
      const { privateKeyHex, publicKeyHex, peerId } = generateTestKeypair();
      const task = signTask(
        makeTask(peerId, { payload: { topic: 'rust-async', depth: 3 } }),
        privateKeyHex,
      );
      const valid = await authService.verify(task, publicKeyHex);
      expect(valid).toBe(true);
    });
  });

  describe('derivePeerIdFromPublicKey', () => {
    it('derives peerId = first 32 hex chars of a valid pubkey', () => {
      const { publicKeyHex, peerId } = generateTestKeypair();
      expect(derivePeerIdFromPublicKey(publicKeyHex)).toBe(peerId.toLowerCase());
    });

    it('returns null for malformed / wrong-length input (fail-closed)', () => {
      expect(derivePeerIdFromPublicKey('')).toBeNull();
      expect(derivePeerIdFromPublicKey('abcd')).toBeNull();
      expect(derivePeerIdFromPublicKey('z'.repeat(64))).toBeNull();
    });
  });

  describe('derivePublicKeyHex', () => {
    it('derives the matching public key from a raw private key', () => {
      const { privateKeyHex, publicKeyHex } = generateTestKeypair();
      expect(authService.derivePublicKeyHex(privateKeyHex)).toBe(publicKeyHex);
    });

    it('returns null on invalid private key', () => {
      expect(authService.derivePublicKeyHex('nope')).toBeNull();
    });
  });

  describe('canonicalJson / hashPayload', () => {
    it('produces key-order-independent canonical output', () => {
      expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    });

    it('hashes equal payloads identically regardless of key order', () => {
      expect(hashPayload({ x: 1, y: [2, 3] })).toBe(hashPayload({ y: [2, 3], x: 1 }));
    });

    it('hashes different payloads differently', () => {
      expect(hashPayload({ x: 1 })).not.toBe(hashPayload({ x: 2 }));
    });
  });

  describe('sign', () => {
    it('should produce consistent Ed25519 signatures', () => {
      const { privateKeyHex } = generateTestKeypair();
      const task = {
        id: 'task-1',
        type: 'health_check' as const,
        payload: {},
        senderPeerId: 'sender',
        timestamp: 1000000000000,
        nonce: 'nonce123',
      };

      const sig1 = authService.sign(task, privateKeyHex);
      const sig2 = authService.sign(task, privateKeyHex);

      expect(sig1).toBe(sig2);
      expect(sig1.length).toBe(128); // Ed25519 = 64 bytes = 128 hex chars
    });

    it('should produce different signatures for different messages', () => {
      const { privateKeyHex } = generateTestKeypair();
      const task1 = {
        id: 'task-1', type: 'health_check' as const, payload: {},
        senderPeerId: 'sender', timestamp: 1000, nonce: 'n1',
      };
      const task2 = {
        id: 'task-2', type: 'health_check' as const, payload: {},
        senderPeerId: 'sender', timestamp: 1000, nonce: 'n1',
      };

      const sig1 = authService.sign(task1, privateKeyHex);
      const sig2 = authService.sign(task2, privateKeyHex);

      expect(sig1).not.toBe(sig2);
    });

    it('should return empty string on error', () => {
      const sig = authService.sign(
        { id: 't', type: 'health_check' as const, payload: {}, senderPeerId: 's', timestamp: 1, nonce: 'n' },
        'invalid-hex-xyz',
      );
      expect(typeof sig).toBe('string');
    });
  });

  describe('verifyEd25519', () => {
    it('should return false on invalid DER key', async () => {
      const valid = await authService.verifyEd25519(
        'message',
        'a'.repeat(128),
        Buffer.from('invalid'),
      );
      expect(valid).toBe(false);
    });
  });

  describe('signEd25519', () => {
    it('should return empty string on invalid DER key', () => {
      const sig = authService.signEd25519('message', Buffer.from('invalid'));
      expect(sig).toBe('');
    });
  });

  describe('clearNonces', () => {
    it('should clear all tracked nonces', () => {
      authService.clearNonces();
      expect(authService.getNonceCount()).toBe(0);
    });
  });

  describe('getNonceCount', () => {
    it('should return 0 initially', () => {
      expect(authService.getNonceCount()).toBe(0);
    });
  });
});
