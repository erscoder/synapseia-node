import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../wallet.js', () => ({
  generateWallet: jest.fn(),
  loadWallet: jest.fn(),
  getOrCreateWallet: jest.fn(),
  getWalletAddress: jest.fn(),
  hasWallet: jest.fn(),
  displayWalletCreationWarning: jest.fn(),
  changeWalletPassword: jest.fn(),
  promptForPassword: jest.fn(),
  promptForNewPassword: jest.fn(),
}));

import * as walletHelper from '../../../wallet.js';
import { WalletService } from '../wallet.service.js';

const mockWallet = {
  publicKey: 'abc123pubkey',
  encryptedPrivateKey: 'encrypted',
  mnemonic: 'word1 word2 word3',
};

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WalletService();
  });

  it('generate() delegates to generateWallet', async () => {
    const mockResult = { wallet: mockWallet, isNew: true };
    (walletHelper.generateWallet as jest.Mock<any>).mockResolvedValue(mockResult);
    const result = await service.generate('/tmp/wallet', 'password');
    expect(walletHelper.generateWallet).toHaveBeenCalledWith('/tmp/wallet', 'password');
    expect(result).toBe(mockResult);
  });

  it('generate() works without args', async () => {
    (walletHelper.generateWallet as jest.Mock<any>).mockResolvedValue({ wallet: mockWallet, isNew: true });
    await service.generate();
    expect(walletHelper.generateWallet).toHaveBeenCalledWith(undefined, undefined);
  });

  it('load() delegates to loadWallet', async () => {
    (walletHelper.loadWallet as jest.Mock<any>).mockResolvedValue(mockWallet);
    const result = await service.load('/tmp/wallet', 'password');
    expect(walletHelper.loadWallet).toHaveBeenCalledWith('/tmp/wallet', 'password');
    expect(result).toBe(mockWallet);
  });

  it('getOrCreate() delegates to getOrCreateWallet', async () => {
    const mockResult = { wallet: mockWallet, isNew: false };
    (walletHelper.getOrCreateWallet as jest.Mock<any>).mockResolvedValue(mockResult);
    const result = await service.getOrCreate('/tmp/wallet', 'password');
    expect(walletHelper.getOrCreateWallet).toHaveBeenCalledWith('/tmp/wallet', 'password');
    expect(result).toBe(mockResult);
  });

  it('getAddress() delegates to getWalletAddress', () => {
    (walletHelper.getWalletAddress as jest.Mock<any>).mockReturnValue('abc123pubkey');
    const result = service.getAddress('/tmp/wallet');
    expect(walletHelper.getWalletAddress).toHaveBeenCalledWith('/tmp/wallet');
    expect(result).toBe('abc123pubkey');
  });

  it('has() delegates to hasWallet - true', () => {
    (walletHelper.hasWallet as jest.Mock<any>).mockReturnValue(true);
    const result = service.has('/tmp/wallet');
    expect(walletHelper.hasWallet).toHaveBeenCalledWith('/tmp/wallet');
    expect(result).toBe(true);
  });

  it('has() delegates to hasWallet - false', () => {
    (walletHelper.hasWallet as jest.Mock<any>).mockReturnValue(false);
    const result = service.has();
    expect(walletHelper.hasWallet).toHaveBeenCalledWith(undefined);
    expect(result).toBe(false);
  });

  it('displayCreationWarning() delegates to displayWalletCreationWarning', () => {
    (walletHelper.displayWalletCreationWarning as jest.Mock<any>).mockReturnValue(undefined);
    service.displayCreationWarning(mockWallet as any);
    expect(walletHelper.displayWalletCreationWarning).toHaveBeenCalledWith(mockWallet);
  });

  it('changePassword() delegates to changeWalletPassword', async () => {
    (walletHelper.changeWalletPassword as jest.Mock<any>).mockResolvedValue(undefined);
    await service.changePassword('/tmp/wallet');
    expect(walletHelper.changeWalletPassword).toHaveBeenCalledWith('/tmp/wallet');
  });

  it('promptForPassword() delegates to promptForPassword', async () => {
    (walletHelper.promptForPassword as jest.Mock<any>).mockResolvedValue('mypassword');
    const result = await service.promptForPassword('Enter password:');
    expect(walletHelper.promptForPassword).toHaveBeenCalledWith('Enter password:');
    expect(result).toBe('mypassword');
  });

  it('promptForNewPassword() delegates to promptForNewPassword', async () => {
    (walletHelper.promptForNewPassword as jest.Mock<any>).mockResolvedValue('newpass');
    const result = await service.promptForNewPassword();
    expect(walletHelper.promptForNewPassword).toHaveBeenCalled();
    expect(result).toBe('newpass');
  });
});
