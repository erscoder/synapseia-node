import { describe, it, expect, jest, afterEach } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';

// @noble/ed25519 is no longer used by identity.ts (replaced with Node crypto)

import {
  generateIdentity,
  loadIdentity,
  updateIdentity,
  getAgentProfile,
  getOrCreateIdentity,
  sign,
  type Identity,
} from '../modules/identity/identity';

describe('identity', () => {
  const testDir = path.join(os.tmpdir(), '.synapse-test-' + Date.now());

  afterEach(() => {
    // Clean up test directory
    
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

    it('should work when directory already exists', () => {
      
      

      // Create directory first
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir);
      }

      const identity = generateIdentity(testDir);
      expect(identity).toBeDefined();
      expect(identity.peerId).toBeDefined();
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
      
      const identityPath = path.join(testDir, 'identity.json');

      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }
      fs.writeFileSync(identityPath, JSON.stringify({ invalid: 'data' }));

      expect(() => loadIdentity(testDir)).toThrow('Invalid identity file structure');
    });

    it('should backfill missing agentId', () => {
      
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
      
      const identityPath = path.join(testDir, 'identity.json');

      const generated = generateIdentity(testDir);

      const content = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
      delete content.tier;
      fs.writeFileSync(identityPath, JSON.stringify(content));

      const loaded = loadIdentity(testDir);

      expect(loaded.tier).toBe(0);
    });

    it('should backfill missing mode', () => {
      
      const identityPath = path.join(testDir, 'identity.json');

      const generated = generateIdentity(testDir);

      const content = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
      delete content.mode;
      fs.writeFileSync(identityPath, JSON.stringify(content));

      const loaded = loadIdentity(testDir);

      expect(loaded.mode).toBe('chill');
    });

    it('should backfill missing status', () => {
      
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

    it('should use default directory when not specified', () => {
      
      
      
      

      const defaultDir = path.join(os.homedir(), '.synapse');

      // Clean up default dir if exists
      try { fs.rmSync(defaultDir, { recursive: true, force: true }); } catch {}

      // Generate to default dir, then update with default param
      const identity = generateIdentity();
      updateIdentity({ tier: 3 });

      const loaded = loadIdentity();
      expect(loaded.tier).toBe(3);

      // Clean up
      try { fs.rmSync(defaultDir, { recursive: true, force: true }); } catch {}
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
    it('should sign a message', async () => {
      
      const privateKeyHex = crypto.randomBytes(32).toString('hex');
      const message = 'test message';
      const signature = await sign(message, privateKeyHex);

      expect(typeof signature).toBe('string');
      expect(signature.length).toBe(64); // HMAC-SHA256 signature = 32 bytes = 64 hex chars
    });

    it('should produce different signatures for different messages', async () => {
      
      const privateKeyHex = crypto.randomBytes(32).toString('hex');
      const sig1 = await sign('message1', privateKeyHex);
      const sig2 = await sign('message2', privateKeyHex);

      expect(sig1).not.toBe(sig2);
    });

    it('should produce same signature for same message', async () => {
      
      const privateKeyHex = crypto.randomBytes(32).toString('hex');
      const sig1 = await sign('same message', privateKeyHex);
      const sig2 = await sign('same message', privateKeyHex);

      expect(sig1).toBe(sig2);
    });
  });

  describe('getOrCreateIdentity', () => {
    it('loads existing identity', () => {
      // Generate first, then getOrCreate should load it
      generateIdentity(testDir);
      const identity = getOrCreateIdentity(testDir);
      expect(identity).toBeDefined();
      expect(identity.peerId).toBeDefined();
      expect(identity.publicKey).toBeDefined();
    });

    it('creates identity when none exists', () => {
      const freshDir = path.join(os.tmpdir(), '.synapse-getorcreate-' + Date.now());
      const identity = getOrCreateIdentity(freshDir);
      expect(identity).toBeDefined();
      expect(identity.peerId).toBeDefined();
      // Clean up
      
      try { fs.rmSync(freshDir, { recursive: true }); } catch {}
    });
  });

  describe('getAgentProfile fallback branches', () => {
    it('uses fallback values for missing optional fields', () => {
      const minimalIdentity: Identity = {
        peerId: 'abc123',
        publicKey: 'deadbeefcafe1234',
        privateKey: 'private',
        createdAt: 12345,
        // agentId, tier, mode, status all undefined
      };
      const profile = getAgentProfile(minimalIdentity);
      expect(profile.agentId).toBe('deadbeef'); // first 8 chars of publicKey
      expect(profile.tier).toBe(0);
      expect(profile.mode).toBe('chill');
      expect(profile.status).toBe('idle');
    });
  });

  describe('updateIdentity partial branches', () => {
    it('updates only status', () => {
      generateIdentity(testDir);
      const updated = updateIdentity({ status: 'active' }, testDir);
      expect(updated.status).toBe('active');
    });

    it('updates tier to 0 explicitly', () => {
      generateIdentity(testDir);
      updateIdentity({ tier: 5 }, testDir);
      const updated = updateIdentity({ tier: 0 }, testDir);
      expect(updated.tier).toBe(0);
    });

    it('does not change unspecified fields', () => {
      generateIdentity(testDir);
      updateIdentity({ tier: 3, mode: 'power', status: 'active' }, testDir);
      const updated = updateIdentity({ tier: 5 }, testDir);
      expect(updated.tier).toBe(5);
      expect(updated.mode).toBe('power'); // unchanged
      expect(updated.status).toBe('active'); // unchanged
    });
  });

  describe('loadIdentity backfill branches', () => {
    it('backfills missing A16 fields from old format', () => {
      
      // Write old-format identity without A16 fields
      const oldIdentity = {
        peerId: 'old-peer-123',
        publicKey: 'aabbccdd11223344',
        privateKey: 'privkey123',
        createdAt: 999999,
      };
      if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, 'identity.json'), JSON.stringify(oldIdentity));

      const loaded = loadIdentity(testDir);
      expect(loaded.agentId).toBe('aabbccdd'); // backfilled
      expect(loaded.tier).toBe(0); // backfilled
      expect(loaded.mode).toBe('chill'); // backfilled
      expect(loaded.status).toBe('idle'); // backfilled
    });
  });

  describe('getOrCreateIdentity', () => {
    it('should return existing identity if found', () => {
      

      generateIdentity(testDir);
      const identity = getOrCreateIdentity(testDir);

      expect(identity.peerId).toBeDefined();
      expect(identity.publicKey).toBeDefined();
    });

    it('should create new identity if not found', () => {
      

      // Use unique temp dir to ensure no existing identity
      const newDir = path.join(testDir, 'new-identity');

      const identity = getOrCreateIdentity(newDir);

      expect(identity.peerId).toBeDefined();
      expect(identity.publicKey).toBeDefined();
      expect(identity.createdAt).toBeDefined();
    });

    it('should handle error when loading identity and create new one', () => {
      

      // Use test dir without existing identity - tests catch block
      const newDir = path.join(testDir, 'identity-test-2');

      const identity = getOrCreateIdentity(newDir);
      expect(identity.peerId).toBeDefined();
    });
  });
});
