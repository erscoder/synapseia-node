import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IdentityHelper } from '../identity';

/**
 * Direct coverage for IdentityHelper using REAL Node Ed25519 crypto.
 *
 * The sibling identity.service.spec.ts mocks IdentityHelper to test the
 * thin IdentityService delegation layer — useful, but it gives ZERO
 * cryptographic coverage (a broken sign/verify would still pass there).
 * This spec exercises the actual key generation, sign/verify round-trip,
 * tamper rejection, and load==persist invariant so a regression in the
 * node's auth-signing primitive fails CI here.
 */
describe('IdentityHelper (real Node Ed25519 crypto)', () => {
  let helper: IdentityHelper;
  let tmpDir: string;

  beforeEach(() => {
    helper = new IdentityHelper();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-identity-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('generateIdentity', () => {
    it('produces a usable Ed25519 keypair with the documented shape', () => {
      const id = helper.generateIdentity(tmpDir);

      // publicKey / privateKey are raw 32-byte hex (64 hex chars).
      expect(id.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(id.privateKey).toMatch(/^[0-9a-f]{64}$/);
      // peerId is the first 32 hex chars of the public key; agentId the first 8.
      expect(id.peerId).toBe(id.publicKey.slice(0, 32));
      expect(id.agentId).toBe(id.publicKey.slice(0, 8));
      // A16 defaults.
      expect(id.tier).toBe(0);
      expect(id.mode).toBe('chill');
      expect(id.status).toBe('idle');
      expect(typeof id.createdAt).toBe('number');
      // It actually persisted identity.json.
      expect(fs.existsSync(path.join(tmpDir, 'identity.json'))).toBe(true);
    });

    it('generates distinct keypairs on successive calls', () => {
      const a = helper.generateIdentity(tmpDir);
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-identity-b-'));
      try {
        const b = helper.generateIdentity(otherDir);
        expect(a.privateKey).not.toBe(b.privateKey);
        expect(a.publicKey).not.toBe(b.publicKey);
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });
  });

  describe('sign + verifySignature round-trip', () => {
    it('a signature produced by sign() verifies under verifySignature()', async () => {
      const id = helper.generateIdentity(tmpDir);
      const message = 'heartbeat:peer-1:1717000000';

      const sig = await helper.sign(message, id.privateKey);
      // 64-byte Ed25519 signature = 128 hex chars (NOT a stubbed zero value).
      expect(sig).toMatch(/^[0-9a-f]{128}$/);

      await expect(
        helper.verifySignature(message, sig, id.publicKey),
      ).resolves.toBe(true);
    });

    it('returns false for a tampered message', async () => {
      const id = helper.generateIdentity(tmpDir);
      const sig = await helper.sign('original-message', id.privateKey);
      await expect(
        helper.verifySignature('tampered-message', sig, id.publicKey),
      ).resolves.toBe(false);
    });

    it('returns false for a tampered signature', async () => {
      const id = helper.generateIdentity(tmpDir);
      const message = 'msg';
      const sig = await helper.sign(message, id.privateKey);
      // Flip the last hex nibble of the signature.
      const lastChar = sig.slice(-1);
      const flipped = sig.slice(0, -1) + (lastChar === '0' ? '1' : '0');
      await expect(
        helper.verifySignature(message, flipped, id.publicKey),
      ).resolves.toBe(false);
    });

    it('returns false when verified against a different public key', async () => {
      const id = helper.generateIdentity(tmpDir);
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-identity-c-'));
      try {
        const other = helper.generateIdentity(otherDir);
        const message = 'msg';
        const sig = await helper.sign(message, id.privateKey);
        await expect(
          helper.verifySignature(message, sig, other.publicKey),
        ).resolves.toBe(false);
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });

    it('returns false (never throws) on malformed signature/key hex', async () => {
      const id = helper.generateIdentity(tmpDir);
      await expect(
        helper.verifySignature('msg', 'not-hex', id.publicKey),
      ).resolves.toBe(false);
      await expect(
        helper.verifySignature('msg', 'aa', 'also-not-a-valid-key'),
      ).resolves.toBe(false);
    });
  });

  describe('load == persist', () => {
    it('loadIdentity returns the same identity generateIdentity persisted', () => {
      const created = helper.generateIdentity(tmpDir);
      const loaded = helper.loadIdentity(tmpDir);
      expect(loaded.peerId).toBe(created.peerId);
      expect(loaded.publicKey).toBe(created.publicKey);
      expect(loaded.privateKey).toBe(created.privateKey);
      expect(loaded.createdAt).toBe(created.createdAt);
    });

    it('a signature made with the loaded key still verifies (round-trips through disk)', async () => {
      const created = helper.generateIdentity(tmpDir);
      const loaded = helper.loadIdentity(tmpDir);
      const message = 'persisted-key-sign';
      const sig = await helper.sign(message, loaded.privateKey);
      await expect(
        helper.verifySignature(message, sig, created.publicKey),
      ).resolves.toBe(true);
    });
  });
});
