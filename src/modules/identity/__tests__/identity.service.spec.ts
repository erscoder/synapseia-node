import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { IdentityHelper } from '../../../identity.js';
import { IdentityService } from '../identity.service.js';

const mockIdentity = {
  peerId: 'peer-1',
  publicKey: 'pubkey',
  privateKey: 'privkey',
  createdAt: 1000,
  agentId: 'agent01',
  tier: 0,
  mode: 'chill' as const,
  status: 'idle' as const,
};

describe('IdentityService', () => {
  let service: IdentityService;
  let identityHelper: jest.Mocked<IdentityHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        IdentityService,
        {
          provide: IdentityHelper,
          useValue: {
            generateIdentity: jest.fn(),
            loadIdentity: jest.fn(),
            getOrCreateIdentity: jest.fn(),
            updateIdentity: jest.fn(),
            getAgentProfile: jest.fn(),
            sign: jest.fn(),
            verifySignature: jest.fn(),
            canonicalPayload: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<IdentityService>(IdentityService);
    identityHelper = module.get(IdentityHelper);
    jest.clearAllMocks();
  });

  it('generate() delegates to identityHelper.generateIdentity', () => {
    (identityHelper.generateIdentity as jest.Mock<any>).mockReturnValue(mockIdentity);
    const result = service.generate('/tmp/test');
    expect(identityHelper.generateIdentity).toHaveBeenCalledWith('/tmp/test');
    expect(result).toBe(mockIdentity);
  });

  it('generate() works without args', () => {
    (identityHelper.generateIdentity as jest.Mock<any>).mockReturnValue(mockIdentity);
    service.generate();
    expect(identityHelper.generateIdentity).toHaveBeenCalledWith(undefined);
  });

  it('load() delegates to identityHelper.loadIdentity', () => {
    (identityHelper.loadIdentity as jest.Mock<any>).mockReturnValue(mockIdentity);
    const result = service.load('/tmp/test');
    expect(identityHelper.loadIdentity).toHaveBeenCalledWith('/tmp/test');
    expect(result).toBe(mockIdentity);
  });

  it('getOrCreate() delegates to identityHelper.getOrCreateIdentity', () => {
    (identityHelper.getOrCreateIdentity as jest.Mock<any>).mockReturnValue(mockIdentity);
    const result = service.getOrCreate('/tmp/test');
    expect(identityHelper.getOrCreateIdentity).toHaveBeenCalledWith('/tmp/test');
    expect(result).toBe(mockIdentity);
  });

  it('update() delegates to identityHelper.updateIdentity', () => {
    const updates = { tier: 3 };
    (identityHelper.updateIdentity as jest.Mock<any>).mockReturnValue(mockIdentity);
    const result = service.update(updates, '/tmp/test');
    expect(identityHelper.updateIdentity).toHaveBeenCalledWith(updates, '/tmp/test');
    expect(result).toBe(mockIdentity);
  });

  it('getProfile() delegates to identityHelper.getAgentProfile', () => {
    const profile = { agentId: 'agent01', peerId: 'peer-1', tier: 0, mode: 'chill', status: 'idle', createdAt: 1000, publicKey: 'pubkey' };
    (identityHelper.getAgentProfile as jest.Mock<any>).mockReturnValue(profile);
    const result = service.getProfile(mockIdentity);
    expect(identityHelper.getAgentProfile).toHaveBeenCalledWith(mockIdentity);
    expect(result).toBe(profile);
  });

  it('sign() delegates to identityHelper.sign', async () => {
    (identityHelper.sign as jest.Mock<any>).mockResolvedValue('abc123sig');
    const result = await service.sign('hello', 'privhex');
    expect(identityHelper.sign).toHaveBeenCalledWith('hello', 'privhex');
    expect(result).toBe('abc123sig');
  });

  it('verify() delegates to identityHelper.verifySignature', async () => {
    (identityHelper.verifySignature as jest.Mock<any>).mockResolvedValue(true);
    const result = await service.verify('msg', 'sig', 'pubkey');
    expect(identityHelper.verifySignature).toHaveBeenCalledWith('msg', 'sig', 'pubkey');
    expect(result).toBe(true);
  });

  it('canonicalPayload() delegates to identityHelper.canonicalPayload', () => {
    (identityHelper.canonicalPayload as jest.Mock<any>).mockReturnValue('{"a":1}');
    const result = service.canonicalPayload({ a: 1 });
    expect(identityHelper.canonicalPayload).toHaveBeenCalledWith({ a: 1 });
    expect(result).toBe('{"a":1}');
  });
});
