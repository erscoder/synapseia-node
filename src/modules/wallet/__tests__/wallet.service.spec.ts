import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { WalletHelper } from '../helpers/wallet.js';
import { WalletService } from '../wallet.service.js';

const mockWallet = {
  publicKey: 'abc123pubkey',
  encryptedPrivateKey: 'encrypted',
  mnemonic: 'word1 word2 word3',
};

describe('WalletService', () => {
  let service: WalletService;
  let walletHelper: jest.Mocked<WalletHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: WalletHelper,
          useValue: {
            generateWallet: jest.fn(),
            loadWallet: jest.fn(),
            getOrCreateWallet: jest.fn(),
            getWalletAddress: jest.fn(),
            hasWallet: jest.fn(),
            displayWalletCreationWarning: jest.fn(),
            changeWalletPassword: jest.fn(),
            promptForPassword: jest.fn(),
            promptForNewPassword: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
    walletHelper = module.get(WalletHelper);
  });

  it('generate() delegates to generateWallet', async () => {
    const mockResult = { wallet: mockWallet, isNew: true };
    walletHelper.generateWallet.mockResolvedValue(mockResult as any);
    const result = await service.generate('/tmp/wallet', 'password');
    expect(walletHelper.generateWallet).toHaveBeenCalledWith('/tmp/wallet', 'password');
    expect(result).toBe(mockResult);
  });

  it('generate() works without args', async () => {
    walletHelper.generateWallet.mockResolvedValue({ wallet: mockWallet, isNew: true } as any);
    await service.generate();
    expect(walletHelper.generateWallet).toHaveBeenCalledWith(undefined, undefined);
  });

  it('load() delegates to loadWallet', async () => {
    walletHelper.loadWallet.mockResolvedValue(mockWallet as any);
    const result = await service.load('/tmp/wallet', 'password');
    expect(walletHelper.loadWallet).toHaveBeenCalledWith('/tmp/wallet', 'password');
    expect(result).toBe(mockWallet);
  });

  it('getOrCreate() delegates to getOrCreateWallet', async () => {
    const mockResult = { wallet: mockWallet, isNew: false };
    walletHelper.getOrCreateWallet.mockResolvedValue(mockResult as any);
    const result = await service.getOrCreate('/tmp/wallet', 'password');
    expect(walletHelper.getOrCreateWallet).toHaveBeenCalledWith('/tmp/wallet', 'password');
    expect(result).toBe(mockResult);
  });

  it('getAddress() delegates to getWalletAddress', () => {
    walletHelper.getWalletAddress.mockReturnValue('abc123pubkey');
    const result = service.getAddress('/tmp/wallet');
    expect(walletHelper.getWalletAddress).toHaveBeenCalledWith('/tmp/wallet');
    expect(result).toBe('abc123pubkey');
  });

  it('has() delegates to hasWallet - true', () => {
    walletHelper.hasWallet.mockReturnValue(true);
    const result = service.has('/tmp/wallet');
    expect(walletHelper.hasWallet).toHaveBeenCalledWith('/tmp/wallet');
    expect(result).toBe(true);
  });

  it('has() delegates to hasWallet - false', () => {
    walletHelper.hasWallet.mockReturnValue(false);
    const result = service.has();
    expect(walletHelper.hasWallet).toHaveBeenCalledWith(undefined);
    expect(result).toBe(false);
  });

  it('displayCreationWarning() delegates to displayWalletCreationWarning', () => {
    walletHelper.displayWalletCreationWarning.mockReturnValue(undefined);
    service.displayCreationWarning(mockWallet as any);
    expect(walletHelper.displayWalletCreationWarning).toHaveBeenCalledWith(mockWallet);
  });

  it('changePassword() delegates to changeWalletPassword', async () => {
    walletHelper.changeWalletPassword.mockResolvedValue(undefined);
    await service.changePassword('/tmp/wallet');
    expect(walletHelper.changeWalletPassword).toHaveBeenCalledWith('/tmp/wallet');
  });

  it('promptForPassword() delegates to promptForPassword', async () => {
    walletHelper.promptForPassword.mockResolvedValue('mypassword');
    const result = await service.promptForPassword('Enter password:');
    expect(walletHelper.promptForPassword).toHaveBeenCalledWith('Enter password:');
    expect(result).toBe('mypassword');
  });

  it('promptForNewPassword() delegates to promptForNewPassword', async () => {
    walletHelper.promptForNewPassword.mockResolvedValue('newpass');
    const result = await service.promptForNewPassword();
    expect(walletHelper.promptForNewPassword).toHaveBeenCalled();
    expect(result).toBe('newpass');
  });
});
