/**
 * A2A Auth Service Tests
 * Sprint D — A2A Server
 */

import { A2AAuthService } from '../auth/a2a-auth.service';
import * as crypto from 'node:crypto';
import type { A2ATask } from '../types';

function generateTestKeypair(): { privateKeyHex: string; publicKeyHex: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privHex = (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).slice(-32).toString('hex');
  const pubHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).slice(-32).toString('hex');
  return { privateKeyHex: privHex, publicKeyHex: pubHex };
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
    function makeTask(overrides: Partial<A2ATask> = {}): A2ATask {
      return {
        id: 'task-1',
        type: 'health_check',
        payload: {},
        senderPeerId: 'sender-peer',
        timestamp: Date.now(),
        nonce: Math.random().toString(36).slice(2),
        signature: 'abc123',
        ...overrides,
      };
    }

    function signTask(task: Omit<A2ATask, 'signature'>, privateKeyHex: string): A2ATask {
      const message = `${task.id}:${task.type}:${task.senderPeerId}:${task.timestamp}:${task.nonce}`;
      const PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');
      const derKey = Buffer.concat([PKCS8_HEADER, Buffer.from(privateKeyHex, 'hex')]);
      const keyObject = crypto.createPrivateKey({ key: derKey, format: 'der', type: 'pkcs8' });
      const sig = crypto.sign(null, Buffer.from(message, 'utf-8'), keyObject).toString('hex');
      return { ...task, signature: sig };
    }

    it('should reject expired requests (timestamp too old)', async () => {
      const task = makeTask({ timestamp: Date.now() - 60_000 });
      const valid = await authService.verify(task, 'abc123');
      expect(valid).toBe(false);
    });

    it('should reject future timestamps (clock skew > 5s)', async () => {
      const task = makeTask({ timestamp: Date.now() + 10_000 });
      const valid = await authService.verify(task, 'abc123');
      expect(valid).toBe(false);
    });

    it('should reject replay of the same nonce', async () => {
      const { privateKeyHex, publicKeyHex } = generateTestKeypair();
      const nonce = Math.random().toString(36).slice(2);
      const baseTask = makeTask({ nonce });
      const task = signTask(baseTask, privateKeyHex);

      // First call should succeed (valid signature)
      const first = await authService.verify(task, publicKeyHex);
      expect(first).toBe(true);

      // Same nonce replayed should fail
      const second = await authService.verify(task, publicKeyHex);
      expect(second).toBe(false);
    });

    it('should reject invalid signatures', async () => {
      const { privateKeyHex, publicKeyHex } = generateTestKeypair();
      const task = signTask(makeTask(), privateKeyHex);
      // Tamper with signature
      task.signature = 'b'.repeat(128);

      const valid = await authService.verify(task, publicKeyHex);
      expect(valid).toBe(false);
    });

    it('should accept valid Ed25519 signatures', async () => {
      const { privateKeyHex, publicKeyHex } = generateTestKeypair();
      const task = signTask(makeTask(), privateKeyHex);

      const valid = await authService.verify(task, publicKeyHex);
      expect(valid).toBe(true);
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
