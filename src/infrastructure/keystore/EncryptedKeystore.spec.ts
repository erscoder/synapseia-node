/**
 * EncryptedKeystore unit tests.
 *
 * Coverage:
 *  - happy path round-trip
 *  - wrong passphrase rejection (GCM auth-tag failure -> INVALID_PASSPHRASE)
 *  - missing file -> NOT_FOUND
 *  - corrupt file -> CORRUPT_FILE
 *  - file mode 0600 on Unix (skipped on win32)
 *  - re-encrypt with same passphrase produces a different ciphertext
 *    (random salt + nonce each call)
 */

import { promises as fs, statSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EncryptedKeystore, EncryptedKeystoreError } from './EncryptedKeystore';

let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'synapseia-keystore-'));
  storePath = path.join(tmpDir, 'wallet.keystore.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('EncryptedKeystore', () => {
  it('round-trips a secret key with the correct passphrase', async () => {
    const ks = new EncryptedKeystore(storePath);
    const secret = new Uint8Array(64);
    for (let i = 0; i < secret.length; i++) secret[i] = (i * 7 + 3) & 0xff;

    await ks.encrypt(secret, 'correct horse battery staple');
    const decoded = await ks.decrypt('correct horse battery staple');

    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded.length).toBe(secret.length);
    expect(Array.from(decoded)).toEqual(Array.from(secret));
  });

  it('exists() returns false before encrypt, true after', async () => {
    const ks = new EncryptedKeystore(storePath);
    expect(ks.exists()).toBe(false);
    await ks.encrypt(new Uint8Array([1, 2, 3, 4]), 'pw');
    expect(ks.exists()).toBe(true);
  });

  it('throws INVALID_PASSPHRASE on wrong passphrase', async () => {
    const ks = new EncryptedKeystore(storePath);
    await ks.encrypt(new Uint8Array([9, 8, 7, 6, 5]), 'right-pass');

    await expect(ks.decrypt('wrong-pass')).rejects.toMatchObject({
      name: 'EncryptedKeystoreError',
      code: 'INVALID_PASSPHRASE',
    });
  });

  it('throws NOT_FOUND when keystore file is absent', async () => {
    const ks = new EncryptedKeystore(path.join(tmpDir, 'does-not-exist.json'));
    await expect(ks.decrypt('anything')).rejects.toMatchObject({
      name: 'EncryptedKeystoreError',
      code: 'NOT_FOUND',
    });
  });

  it('throws CORRUPT_FILE when JSON is malformed', async () => {
    await fs.writeFile(storePath, '{not json', { mode: 0o600 });
    const ks = new EncryptedKeystore(storePath);
    await expect(ks.decrypt('pw')).rejects.toMatchObject({
      name: 'EncryptedKeystoreError',
      code: 'CORRUPT_FILE',
    });
  });

  it('throws CORRUPT_FILE when required fields are missing', async () => {
    await fs.writeFile(
      storePath,
      JSON.stringify({ version: 1, kdf: 'scrypt' }),
      { mode: 0o600 },
    );
    const ks = new EncryptedKeystore(storePath);
    await expect(ks.decrypt('pw')).rejects.toMatchObject({
      name: 'EncryptedKeystoreError',
      code: 'CORRUPT_FILE',
    });
  });

  // chmod semantics differ on Windows. Skip there.
  const isUnix = process.platform !== 'win32';
  (isUnix ? it : it.skip)('writes the keystore file with mode 0600', async () => {
    const ks = new EncryptedKeystore(storePath);
    await ks.encrypt(new Uint8Array([1, 2, 3]), 'pw');
    const st = statSync(storePath);
    // strip file-type bits
    const perm = st.mode & 0o777;
    expect(perm).toBe(0o600);
  });

  it('re-encrypt with the same passphrase produces a different ciphertext', async () => {
    const ks = new EncryptedKeystore(storePath);
    const secret = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    await ks.encrypt(secret, 'pw');
    const first = JSON.parse(await fs.readFile(storePath, 'utf-8'));

    await ks.encrypt(secret, 'pw');
    const second = JSON.parse(await fs.readFile(storePath, 'utf-8'));

    expect(first.salt).not.toBe(second.salt);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);

    // Both must still decrypt with the same passphrase.
    const decoded = await ks.decrypt('pw');
    expect(Array.from(decoded)).toEqual(Array.from(secret));
  });

  it('exposes the resolved file path via getPath()', () => {
    const ks = new EncryptedKeystore(storePath);
    expect(ks.getPath()).toBe(storePath);
  });

  it('rejects empty passphrase on encrypt and decrypt', async () => {
    const ks = new EncryptedKeystore(storePath);
    await expect(
      ks.encrypt(new Uint8Array([1]), ''),
    ).rejects.toThrow(/passphrase/i);
    await expect(ks.decrypt('')).rejects.toThrow(/passphrase/i);
  });

  it('rejects empty secret key on encrypt', async () => {
    const ks = new EncryptedKeystore(storePath);
    await expect(
      ks.encrypt(new Uint8Array(0), 'pw'),
    ).rejects.toThrow(/secretKey/);
  });
});
