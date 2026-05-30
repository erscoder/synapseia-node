/**
 * F-node-009 (MED) regression — wallet keystore PBKDF2 iteration bump.
 *
 * The encryptor now writes v2 keystores (600k iterations). The decryptor
 * must still decrypt v1 (100k) keystores produced by previous node
 * releases. We exercise the back-compat path by planting keystores on
 * disk (avoids pulling in @solana/web3.js ESM under jest CJS).
 */
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';

// Mock `fs` so the atomic-write internals (openSync/fsyncSync/renameSync) are
// overridable per-test. `fs`'s native bindings are non-configurable, so a
// plain `jest.spyOn(fs, 'renameSync')` throws "Cannot redefine property".
// We wrap the REAL module in jest.fn delegators and expose a `__failHooks`
// registry a test can populate to force a failure at a specific step.
const fsFailHooks: { [k in 'openSync' | 'fsyncSync' | 'renameSync']?: () => never } = {};
jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  const wrap = (name: 'openSync' | 'fsyncSync' | 'renameSync') =>
    jest.fn((...args: unknown[]) => {
      const hook = fsFailHooks[name];
      if (hook) hook();
      return (real[name] as (...a: unknown[]) => unknown)(...args);
    });
  return {
    ...real,
    openSync: wrap('openSync'),
    fsyncSync: wrap('fsyncSync'),
    renameSync: wrap('renameSync'),
  };
});

// Imported AFTER jest.mock so they resolve to the mocked module.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import * as fs from 'fs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import logger from '../../../utils/logger';
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

describe('Workstream E — transparent weak-PBKDF2 re-encrypt on unlock', () => {
  let tmpDir: string;
  const walletPath = () => path.join(tmpDir, 'wallet.json');

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'syn-wallet-reenc-'));
  });
  afterEach(() => {
    delete fsFailHooks.openSync;
    delete fsFailHooks.fsyncSync;
    delete fsFailHooks.renameSync;
    jest.restoreAllMocks();
    (fs.renameSync as jest.Mock).mockClear?.();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('rewrites a v1 (100k) keystore as v2 (600k) on successful unlock, still decryptable under same password', async () => {
    const secretKey = crypto.randomBytes(64);
    const pubkey = 'PUBKEY-' + crypto.randomBytes(8).toString('hex');
    const password = 'upgrade-me-100k';
    const v1 = encryptForVersion(secretKey, pubkey, password, 1);
    writeFileSync(walletPath(), JSON.stringify(v1));

    const helper = new WalletHelper();
    const loaded = await helper.loadWallet(tmpDir, password);
    expect(Array.from(loaded.secretKey)).toEqual(Array.from(secretKey));

    // On-disk keystore must now be v2 / 600k.
    const onDisk = JSON.parse(readFileSync(walletPath(), 'utf-8')) as EncryptedWallet;
    expect(onDisk.version).toBe(2);
    expect(onDisk.kdfIterations).toBe(PBKDF2_ITERATIONS_V2);
    // No leftover tmp file.
    expect(fs.existsSync(walletPath() + '.tmp')).toBe(false);

    // The rewritten keystore still decrypts under the SAME password to the
    // SAME plaintext key.
    const reloaded = await helper.loadWallet(tmpDir, password);
    expect(reloaded.publicKey).toBe(pubkey);
    expect(Array.from(reloaded.secretKey)).toEqual(Array.from(secretKey));
  });

  it('does NOT rewrite an already-v2 keystore', async () => {
    const secretKey = crypto.randomBytes(64);
    const password = 'already-v2';
    const v2 = encryptForVersion(secretKey, 'PK', password, 2);
    const original = JSON.stringify(v2);
    writeFileSync(walletPath(), original);

    (fs.renameSync as jest.Mock).mockClear();
    const helper = new WalletHelper();
    await helper.loadWallet(tmpDir, password);

    // No atomic persist happened (no rename), file byte-identical.
    expect(fs.renameSync as jest.Mock).not.toHaveBeenCalled();
    expect(readFileSync(walletPath(), 'utf-8')).toBe(original);
  });

  it('atomicity: a forced rename failure NEVER replaces the good wallet.json (original stays valid + decryptable)', async () => {
    const secretKey = crypto.randomBytes(64);
    const pubkey = 'PUBKEY-' + crypto.randomBytes(8).toString('hex');
    const password = 'atomic-rename-fail';
    const v1 = encryptForVersion(secretKey, pubkey, password, 1);
    const originalBytes = JSON.stringify(v1);
    writeFileSync(walletPath(), originalBytes);

    // Simulate a crash/partial-write at the rename step.
    fsFailHooks.renameSync = () => { throw new Error('simulated rename failure (disk full / crash)'); };

    const helper = new WalletHelper();
    // Unlock must still succeed (best-effort upgrade), returning the wallet.
    const loaded = await helper.loadWallet(tmpDir, password);
    expect(Array.from(loaded.secretKey)).toEqual(Array.from(secretKey));

    // The good original is untouched (rename never clobbered it) and the
    // partial tmp was cleaned up.
    expect(readFileSync(walletPath(), 'utf-8')).toBe(originalBytes);
    expect(fs.existsSync(walletPath() + '.tmp')).toBe(false);

    // And it still decrypts to the same key (clear the rename hook so the
    // second load's own upgrade can run without the failure; we only assert
    // the key).
    delete fsFailHooks.renameSync;
    const reloaded = await helper.loadWallet(tmpDir, password);
    expect(Array.from(reloaded.secretKey)).toEqual(Array.from(secretKey));
  });

  it('atomicity: a forced fsync failure NEVER replaces the good wallet.json', async () => {
    const secretKey = crypto.randomBytes(64);
    const password = 'atomic-fsync-fail';
    const v1 = encryptForVersion(secretKey, 'PK', password, 1);
    const originalBytes = JSON.stringify(v1);
    writeFileSync(walletPath(), originalBytes);

    fsFailHooks.fsyncSync = () => { throw new Error('simulated fsync failure'); };

    const helper = new WalletHelper();
    const loaded = await helper.loadWallet(tmpDir, password);
    expect(Array.from(loaded.secretKey)).toEqual(Array.from(secretKey));

    // Original intact, no tmp left behind.
    expect(readFileSync(walletPath(), 'utf-8')).toBe(originalBytes);
    expect(fs.existsSync(walletPath() + '.tmp')).toBe(false);
  });

  it('best-effort: a re-encrypt/persist failure does NOT throw out of loadWallet', async () => {
    const secretKey = crypto.randomBytes(64);
    const password = 'best-effort';
    const v1 = encryptForVersion(secretKey, 'PK', password, 1);
    writeFileSync(walletPath(), JSON.stringify(v1));

    // Force the persist to blow up at the open step.
    fsFailHooks.openSync = () => { throw new Error('simulated open failure'); };

    const helper = new WalletHelper();
    // Must resolve (not reject) with the unlocked wallet.
    await expect(helper.loadWallet(tmpDir, password)).resolves.toMatchObject({
      secretKey: Array.from(secretKey),
    });
  });

  it('never logs secret material during the v1->v2 upgrade', async () => {
    const secretKey = crypto.randomBytes(64);
    const pubkey = 'PUBKEY-' + crypto.randomBytes(8).toString('hex');
    const password = 'no-secret-log-please-1234';
    const v1 = encryptForVersion(secretKey, pubkey, password, 1);
    writeFileSync(walletPath(), JSON.stringify(v1));

    const logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined as never);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined as never);

    const helper = new WalletHelper();
    await helper.loadWallet(tmpDir, password);

    const allLogged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n');

    // No password.
    expect(allLogged).not.toContain(password);
    // No secret-key bytes (hex or decimal-array fragment).
    expect(allLogged).not.toContain(Buffer.from(secretKey).toString('hex'));
    expect(allLogged).not.toContain(secretKey.slice(0, 8).join(','));
    // But the non-secret upgrade fact WAS surfaced.
    expect(allLogged).toMatch(/upgraded keystore v1->v2/);
  });
});
