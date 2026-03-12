import { describe, it, expect, jest, afterEach } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import {
  generateIdentity,
  loadIdentity,
  updateIdentity,
  getAgentProfile,
  sign,
  type Identity,
} from '../identity.js';

describe('identity', () => {
  const testDir = path.join(os.tmpdir(), '.synapse-test-' + Date.now());

  afterEach(() => {
    // Clean up test directory
    const fs = require('fs');
    const identityPath = path.join(testDir, 'identity.json');
    if (fs.existsSync(identityPath)) {
      fs.unlinkSync(identityPath);
    }
  });

  describe('generateIdentity', () => {
    it('should generate a new identity with all required fields', () => {
      const identity = generateIdentity(testDir);

      expect(identity).toBeDefined();
      expect(identity.peerId).toBeDefined();
      expect(identity.publicKey).toBeDefined();
      expect(identity.privateKey).toBeDefined();
      expect(identity.createdAt).toBeDefined();
      expect(typeof identity.peerId).toBe('string');
      expect(typeof identity.publicKey).toBe('string');
      expect(typeof identity.privateKey).toBe('string');
      expect(typeof identity.createdAt).toBe('number');
    });

    it('should generate agentId (first 8 chars of publicKey)', () => {
      const identity = generateIdentity(testDir);

      expect(identity.agentId).toBeDefined();
      expect(typeof identity.agentId).toBe('string');
      expect(identity.agentId).toHaveLength(8);
      expect(identity.agentId).toBe(identity.publicKey.slice(0, 8));
    });

    it('should have default tier of 0', () => {
      const identity = generateIdentity(testDir);

      expect(identity.tier).toBe(0);
    });

    it('should have default mode of chill', () => {
      const identity = generateIdentity(testDir);

      expect(identity.mode).toBe('chill');
    });

    it('should have default status of idle', () => {
      const identity = generateIdentity(testDir);

      expect(identity.status).toBe('idle');
    });

    it('should create identity file', () => {
      const fs = require('fs');
      const identityPath = path.join(testDir, 'identity.json');

      generateIdentity(testDir);

      expect(fs.existsSync(identityPath)).toBe(true);
    });

    it('should be able to load generated identity', () => {
      const generated = generateIdentity(testDir);
      const loaded = loadIdentity(testDir);

      expect(loaded.peerId).toBe(generated.peerId);
      expect(loaded.publicKey).toBe(generated.publicKey);
      expect(loaded.privateKey).toBe(generated.privateKey);
      expect(loaded.agentId).toBe(generated.agentId);
      expect(loaded.tier).toBe(generated.tier);
      expect(loaded.mode).toBe(generated.mode);
      expect(loaded.status).toBe(generated.status);
    });

    it('should generate different identities on multiple calls', () => {
      const fs = require('fs');
      const identityPath = path.join(testDir, 'identity.json');

      const identity1 = generateIdentity(testDir);
      fs.unlinkSync(identityPath);

      const identity2 = generateIdentity(testDir);

      expect(identity1.peerId).not.toBe(identity2.peerId);
      expect(identity1.agentId).not.toBe(identity2.agentId);
    });
  });

  describe('loadIdentity', () => {
    it('should load identity from file', () => {
      const generated = generateIdentity(testDir);
      const loaded = loadIdentity(testDir);

      expect(loaded.peerId).toBe(generated.peerId);
      expect(loaded.publicKey).toBe(generated.publicKey);
      expect(loaded.agentId).toBe(generated.agentId);
    });

    it('should throw if identity file does not exist', () => {
      expect(() => loadIdentity(testDir)).toThrow('Identity not found');
    });

    it('should throw if identity file has invalid structure', () => {
      const fs = require('fs');
      const identityPath = path.join(testDir, 'identity.json');

      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }
      fs.writeFileSync(identityPath, JSON.stringify({ invalid: 'data' }));

      expect(() => loadIdentity(testDir)).toThrow('Invalid identity file structure');
    });

    it('should backfill missing agentId', () => {
      const fs = require('fs');
      const identityPath = path.join(testDir, 'identity.json');

      const generated = generateIdentity(testDir);

      const content = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
      delete content.agentId;
      fs.writeFileSync(identityPath, JSON.stringify(content));

      const loaded = loadIdentity(testDir);

      expect(loaded.agentId).toBeDefined();
      expect(loaded.agentId).toBe(loaded.publicKey.slice(0, 8));
    });

    it('should backfill missing tier', () => {
      const fs = require('fs');
      const identityPath = path.join(testDir, 'identity.json');

      const generated = generateIdentity(testDir);

      const content = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
      delete content.tier;
      fs.writeFileSync(identityPath, JSON.stringify(content));

      const loaded = loadIdentity(testDir);

      expect(loaded.tier).toBe(0);
    });

    it('should backfill missing mode', () => {
      const fs = require('fs');
      const identityPath = path.join(testDir, 'identity.json');

      const generated = generateIdentity(testDir);

      const content = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
      delete content.mode;
      fs.writeFileSync(identityPath, JSON.stringify(content));

      const loaded = loadIdentity(testDir);

      expect(loaded.mode).toBe('chill');
    });

    it('should backfill missing status', () => {
      const fs = require('fs');
      const identityPath = path.join(testDir, 'identity.json');

      const generated = generateIdentity(testDir);

      const content = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
      delete content.status;
      fs.writeFileSync(identityPath, JSON.stringify(content));

      const loaded = loadIdentity(testDir);

      expect(loaded.status).toBe('idle');
    });
  });

  describe('updateIdentity', () => {
    it('should update tier', () => {
      const identity = generateIdentity(testDir);
      expect(identity.tier).toBe(0);

      const updated = updateIdentity({ tier: 5 }, testDir);

      expect(updated.tier).toBe(5);
      expect(updated.agentId).toBe(identity.agentId);
      expect(updated.mode).toBe(identity.mode);
    });

    it('should update mode', () => {
      const identity = generateIdentity(testDir);
      expect(identity.mode).toBe('chill');

      const updated = updateIdentity({ mode: 'power' }, testDir);

      expect(updated.mode).toBe('power');
      expect(updated.agentId).toBe(identity.agentId);
      expect(updated.tier).toBe(identity.tier);
    });

    it('should update status', () => {
      const identity = generateIdentity(testDir);
      expect(identity.status).toBe('idle');

      const updated = updateIdentity({ status: 'active' }, testDir);

      expect(updated.status).toBe('active');
    });

    it('should update multiple fields', () => {
      const identity = generateIdentity(testDir);

      const updated = updateIdentity(
        { tier: 3, mode: 'power', status: 'active' },
        testDir,
      );

      expect(updated.tier).toBe(3);
      expect(updated.mode).toBe('power');
      expect(updated.status).toBe('active');
    });

    it('should persist updates to file', () => {
      const identity = generateIdentity(testDir);
      updateIdentity({ tier: 4 }, testDir);

      const loaded = loadIdentity(testDir);

      expect(loaded.tier).toBe(4);
    });

    it('should not change other fields when updating one', () => {
      const identity = generateIdentity(testDir);
      const originalAgentId = identity.agentId;
      const originalMode = identity.mode;
      const originalStatus = identity.status;

      updateIdentity({ tier: 7 }, testDir);

      const loaded = loadIdentity(testDir);

      expect(loaded.agentId).toBe(originalAgentId);
      expect(loaded.mode).toBe(originalMode);
      expect(loaded.status).toBe(originalStatus);
    });
  });

  describe('getAgentProfile', () => {
    it('should return full agent profile', () => {
      const identity = generateIdentity(testDir);
      const profile = getAgentProfile(identity);

      expect(profile).toBeDefined();
      expect(profile.agentId).toBe(identity.agentId);
      expect(profile.peerId).toBe(identity.peerId);
      expect(profile.tier).toBe(identity.tier);
      expect(profile.mode).toBe(identity.mode);
      expect(profile.status).toBe(identity.status);
      expect(profile.createdAt).toBe(identity.createdAt);
      expect(profile.publicKey).toBe(identity.publicKey);
    });

    it('should work with manually constructed identity', () => {
      const identity: Identity = {
        peerId: 'test-peer-id',
        publicKey: 'a'.repeat(64),
        privateKey: 'b'.repeat(64),
        createdAt: Date.now(),
        agentId: 'aaaaaa01',
        tier: 5,
        mode: 'power',
        status: 'active',
      };

      const profile = getAgentProfile(identity);

      expect(profile.agentId).toBe('aaaaaa01');
      expect(profile.peerId).toBe('test-peer-id');
      expect(profile.tier).toBe(5);
      expect(profile.mode).toBe('power');
      expect(profile.status).toBe('active');
    });

    it('should derive agentId if missing', () => {
      const identity: Identity = {
        peerId: 'test-peer-id',
        publicKey: 'a'.repeat(64),
        privateKey: 'b'.repeat(64),
        createdAt: Date.now(),
      };

      const profile = getAgentProfile(identity);

      expect(profile.agentId).toBe('aaaaaaaa');
    });

    it('should use default tier if missing', () => {
      const identity: Identity = {
        peerId: 'test-peer-id',
        publicKey: 'a'.repeat(64),
        privateKey: 'b'.repeat(64),
        createdAt: Date.now(),
      };

      const profile = getAgentProfile(identity);

      expect(profile.tier).toBe(0);
    });

    it('should use default mode if missing', () => {
      const identity: Identity = {
        peerId: 'test-peer-id',
        publicKey: 'a'.repeat(64),
        privateKey: 'b'.repeat(64),
        createdAt: Date.now(),
      };

      const profile = getAgentProfile(identity);

      expect(profile.mode).toBe('chill');
    });

    it('should use default status if missing', () => {
      const identity: Identity = {
        peerId: 'test-peer-id',
        publicKey: 'a'.repeat(64),
        privateKey: 'b'.repeat(64),
        createdAt: Date.now(),
      };

      const profile = getAgentProfile(identity);

      expect(profile.status).toBe('idle');
    });
  });

  describe('sign', () => {
    it('should sign a message', () => {
      const crypto = require('crypto');
      const privateKeyHex = crypto.randomBytes(32).toString('hex');
      const message = 'test message';
      const signature = sign(message, privateKeyHex);

      expect(typeof signature).toBe('string');
      expect(signature.length).toBe(64); // SHA256 hex output = 64 chars
    });

    it('should produce different signatures for different messages', () => {
      const crypto = require('crypto');
      const privateKeyHex = crypto.randomBytes(32).toString('hex');
      const sig1 = sign('message1', privateKeyHex);
      const sig2 = sign('message2', privateKeyHex);

      expect(sig1).not.toBe(sig2);
    });

    it('should produce same signature for same message', () => {
      const crypto = require('crypto');
      const privateKeyHex = crypto.randomBytes(32).toString('hex');
      const sig1 = sign('same message', privateKeyHex);
      const sig2 = sign('same message', privateKeyHex);

      expect(sig1).toBe(sig2);
    });
  });
});
