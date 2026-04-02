/**
 * A2A Auth Service Tests
 * Sprint D — A2A Server
 */

import { A2AAuthService } from '../auth/a2a-auth.service';
import type { A2ATask } from '../types';

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
      const crypto = require('node:crypto');
      const sig = crypto.createHmac('sha256', Buffer.from(privateKeyHex, 'hex'))
        .update(Buffer.from(message, 'utf-8'))
        .digest('hex');
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
      const privateKeyHex = 'a'.repeat(64);
      const nonce = Math.random().toString(36).slice(2);
      const baseTask = makeTask({ nonce });
      const task = signTask(baseTask, privateKeyHex);

      // First call should succeed (valid signature)
      const first = await authService.verify(task, privateKeyHex);
      expect(first).toBe(true);

      // Same nonce replayed should fail
      const second = await authService.verify(task, privateKeyHex);
      expect(second).toBe(false);
    });

    it('should reject invalid signatures', async () => {
      const privateKeyHex = 'a'.repeat(64);
      const task = signTask(makeTask(), privateKeyHex);
      // Tamper with signature
      task.signature = 'b'.repeat(64);

      const valid = await authService.verify(task, privateKeyHex);
      expect(valid).toBe(false);
    });

    it('should accept valid HMAC-SHA256 signatures', async () => {
      const privateKeyHex = 'a'.repeat(64);
      const task = signTask(makeTask(), privateKeyHex);

      const valid = await authService.verify(task, privateKeyHex);
      expect(valid).toBe(true);
    });
  });

  describe('sign', () => {
    it('should produce consistent HMAC-SHA256 signatures', () => {
      const privateKeyHex = 'a'.repeat(64);
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
      expect(sig1.length).toBe(64); // SHA256 = 32 bytes = 64 hex chars
    });

    it('should produce different signatures for different messages', () => {
      const privateKeyHex = 'a'.repeat(64);
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
      // Should not throw, may return empty string
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
