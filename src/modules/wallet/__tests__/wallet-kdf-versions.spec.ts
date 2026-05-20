/**
 * F-node-009 (MED) regression — wallet keystore PBKDF2 iteration bump.
 *
 * The encryptor now writes v2 keystores (600k iterations). The decryptor
 * must still decrypt v1 (100k) keystores produced by previous node
 * releases. We exercise the back-compat path by planting keystores on
 * disk (avoids pulling in @solana/web3.js ESM under jest CJS).
 */
import * as crypto from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  WalletHelper,
  PBKDF2_ITERATIONS_V1,
  PBKDF2_ITERATIONS_V2,
  type EncryptedWallet,
} from '../wallet';

const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const KEY_LENGTH = 32;

function encryptForVersion(secretKey: Uint8Array, publicKey: string, password: string, version: 1 | 2): EncryptedWallet {
  const iterations = version === 1 ? PBKDF2_ITERATIONS_V1 : PBKDF2_ITERATIONS_V2;
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.pbkdf2Sync(password, salt, iterations, KEY_LENGTH, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([salt, iv, authTag, encrypted]);
  return {
    version,
    publicKey,
    encryptedData: combined.toString('base64'),
    salt: salt.toString('base64'),
    kdf: 'pbkdf2-sha256',
    kdfIterations: iterations,
    createdAt: new Date().toISOString(),
  };
}

describe('F-node-009 — wallet PBKDF2 versioning', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'syn-wallet-kdf-'));
  });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('exports the V1 (100k) and V2 (600k) constants', () => {
    expect(PBKDF2_ITERATIONS_V1).toBe(100_000);
    expect(PBKDF2_ITERATIONS_V2).toBe(600_000);
  });

  it('decrypts a legacy v1 (100k) keystore written before the bump', async () => {
    const secretKey = crypto.randomBytes(64);
    const pubkey = 'PUBKEY-' + crypto.randomBytes(8).toString('hex');
    const password = 'legacy-100k-pass';
    const v1 = encryptForVersion(secretKey, pubkey, password, 1);
    writeFileSync(path.join(tmpDir, 'wallet.json'), JSON.stringify(v1));

    const helper = new WalletHelper();
    const wallet = await helper.loadWallet(tmpDir, password);
    expect(wallet.publicKey).toBe(pubkey);
    expect(Array.from(wallet.secretKey)).toEqual(Array.from(secretKey));
  });

  it('decrypts a v2 (600k) keystore', async () => {
    const secretKey = crypto.randomBytes(64);
    const pubkey = 'PUBKEY-' + crypto.randomBytes(8).toString('hex');
    const password = 'round-trip-v2';
    const v2 = encryptForVersion(secretKey, pubkey, password, 2);
    writeFileSync(path.join(tmpDir, 'wallet.json'), JSON.stringify(v2));

    const helper = new WalletHelper();
    const wallet = await helper.loadWallet(tmpDir, password);
    expect(wallet.publicKey).toBe(pubkey);
    expect(Array.from(wallet.secretKey)).toEqual(Array.from(secretKey));
  });

  it('rejects an invalid password on a v2 keystore', async () => {
    const secretKey = crypto.randomBytes(64);
    const v2 = encryptForVersion(secretKey, 'PK', 'right-password', 2);
    writeFileSync(path.join(tmpDir, 'wallet.json'), JSON.stringify(v2));
    const helper = new WalletHelper();
    await expect(helper.loadWallet(tmpDir, 'wrong-password')).rejects.toThrow(/Invalid password/);
  });

  it('rejects an invalid password on a v1 keystore (no silent v2 misderive)', async () => {
    const secretKey = crypto.randomBytes(64);
    const v1 = encryptForVersion(secretKey, 'PK', 'right-legacy', 1);
    writeFileSync(path.join(tmpDir, 'wallet.json'), JSON.stringify(v1));
    const helper = new WalletHelper();
    await expect(helper.loadWallet(tmpDir, 'wrong-password')).rejects.toThrow(/Invalid password/);
  });

  it('honors kdfIterations even when version flag is absent (legacy back-compat)', async () => {
    // Some pre-versioned wallets in the wild may have kdfIterations set
    // but no `version` tag. The decryptor must still pick the iter
    // count from the field rather than assuming a constant.
    const secretKey = crypto.randomBytes(64);
    const password = 'pre-version-field';
    const v1Like = encryptForVersion(secretKey, 'PK', password, 1) as Omit<EncryptedWallet, 'version'> & { version?: unknown };
    delete v1Like.version;
    writeFileSync(path.join(tmpDir, 'wallet.json'), JSON.stringify(v1Like));
    const helper = new WalletHelper();
    const wallet = await helper.loadWallet(tmpDir, password);
    expect(Array.from(wallet.secretKey)).toEqual(Array.from(secretKey));
  });
});
