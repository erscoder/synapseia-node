/**
 * EncryptedKeystore - hardened at-rest storage for operator wallet secret keys.
 *
 * Motivation (Phase 0.3 premortem F9):
 *   A malicious `prepare` / `postinstall` script in any transitive npm
 *   dependency runs with the user's UID and can exfiltrate plaintext
 *   files from $HOME (.env, $HOME/.synapseia/*). The legacy wallet.json
 *   path is encrypted, but the operator's wallet password sometimes
 *   leaks via `SYNAPSEIA_WALLET_PASSWORD=` in `.env`, collapsing the
 *   encryption back to plaintext. This keystore is the dedicated
 *   passphrase-only flow with stronger primitives.
 *
 *   Boot-path policy (see packages/node/src/cli/index.ts):
 *   when this keystore is present, the CLI loads the wallet from here
 *   FIRST and never decrypts the legacy wallet.json, so
 *   SYNAPSEIA_WALLET_PASSWORD is never read. The non-interactive
 *   passphrase channel is a file-mounted secret
 *   (SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE), not an env var, so a
 *   malicious postinstall cannot grep it out of `process.env`.
 *
 * Crypto choices:
 *   - KDF: scrypt (N=2^16, r=8, p=1, 32-byte output). scrypt is memory-
 *     hard (~64 MiB working set) like argon2id and is shipped in Node's
 *     stdlib (no new dependency = no new supply-chain surface, which is
 *     the exact thing this skill is supposed to close).
 *     TODO(phase0.3-followup): once the jest mock workaround for
 *     `@noble/hashes` is in place we can upgrade the KDF to argon2id
 *     (stronger memory-hardness profile). Until then scrypt is the
 *     dependency-free pick.
 *   - Cipher: AES-256-GCM. AEAD with 16-byte auth tag.
 *   - All RNG via crypto.randomBytes (CSPRNG).
 *
 * File format (JSON, mode 0600):
 *   {
 *     "version": 1,
 *     "kdf": "scrypt",
 *     "kdfParams": { "N": 65536, "r": 8, "p": 1, "dkLen": 32 },
 *     "salt":      "<base64, 32 bytes>",
 *     "nonce":     "<base64, 12 bytes>",          // GCM IV
 *     "authTag":   "<base64, 16 bytes>",
 *     "ciphertext":"<base64, |secretKey| bytes>"
 *   }
 */

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  randomBytes,
  scrypt as scryptCb,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'crypto';

const SALT_LEN = 32;
const NONCE_LEN = 12; // AES-GCM standard IV length
const AUTH_TAG_LEN = 16;
const DKLEN = 32; // AES-256

// scrypt params chosen for interactive CLI UX (~1s on modern desktop).
const SCRYPT_N = 65536; // 2^16
const SCRYPT_R = 8;
const SCRYPT_P = 1;
// Node default scrypt maxmem is 32 MiB; N=65536 r=8 needs ~64 MiB.
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

const DEFAULT_FILE = path.join(os.homedir(), '.synapseia', 'wallet.keystore.json');

export interface KeystoreFile {
  version: 1;
  kdf: 'scrypt';
  kdfParams: { N: number; r: number; p: number; dkLen: number };
  salt: string;
  nonce: string;
  authTag: string;
  ciphertext: string;
}

function expandPath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

function scrypt(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(
      passphrase,
      salt,
      DKLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (err, derived) => {
        if (err) reject(err);
        else resolve(derived as Buffer);
      },
    );
  });
}

export class EncryptedKeystoreError extends Error {
  constructor(message: string, public readonly code: 'NOT_FOUND' | 'INVALID_PASSPHRASE' | 'CORRUPT_FILE') {
    super(message);
    this.name = 'EncryptedKeystoreError';
  }
}

export class EncryptedKeystore {
  private readonly filePath: string;

  constructor(filePath: string = DEFAULT_FILE) {
    this.filePath = expandPath(filePath);
  }

  /** Absolute path to the keystore file on disk. */
  getPath(): string {
    return this.filePath;
  }

  /** True if the keystore file is present on disk. */
  exists(): boolean {
    return existsSync(this.filePath);
  }

  /**
   * Encrypt `secretKey` with `passphrase` and write the keystore file
   * with mode 0600. The directory is created with mode 0700 if missing.
   * Calling encrypt() with the same passphrase MUST produce a different
   * ciphertext each time (salt and nonce are random).
   */
  async encrypt(secretKey: Uint8Array, passphrase: string): Promise<void> {
    if (!(secretKey instanceof Uint8Array) || secretKey.length === 0) {
      throw new Error('encrypt: secretKey must be a non-empty Uint8Array');
    }
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      throw new Error('encrypt: passphrase must be a non-empty string');
    }

    const salt = randomBytes(SALT_LEN);
    const nonce = randomBytes(NONCE_LEN);
    const key = await scrypt(passphrase, salt);

    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(secretKey)),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    const file: KeystoreFile = {
      version: 1,
      kdf: 'scrypt',
      kdfParams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dkLen: DKLEN },
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };

    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // Write atomic-ish: write then chmod. mode in writeFile is honoured
    // only when the file is created; force-chmod afterwards to cover the
    // overwrite path.
    await fs.writeFile(this.filePath, JSON.stringify(file, null, 2), { mode: 0o600 });
    await fs.chmod(this.filePath, 0o600);
  }

  /**
   * Decrypt the keystore file with `passphrase`. Returns the secret key.
   * Throws EncryptedKeystoreError with code:
   *   - NOT_FOUND          when the file does not exist
   *   - CORRUPT_FILE       when JSON is malformed or fields missing
   *   - INVALID_PASSPHRASE when GCM auth tag verification fails
   */
  async decrypt(passphrase: string): Promise<Uint8Array> {
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      throw new Error('decrypt: passphrase must be a non-empty string');
    }
    if (!this.exists()) {
      throw new EncryptedKeystoreError(
        `Keystore file not found at ${this.filePath}`,
        'NOT_FOUND',
      );
    }

    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err) {
      throw new EncryptedKeystoreError(
        `Cannot read keystore at ${this.filePath}: ${(err as Error).message}`,
        'NOT_FOUND',
      );
    }

    let file: KeystoreFile;
    try {
      file = JSON.parse(raw) as KeystoreFile;
    } catch (err) {
      throw new EncryptedKeystoreError(
        `Keystore JSON is malformed: ${(err as Error).message}`,
        'CORRUPT_FILE',
      );
    }

    if (
      !file ||
      file.version !== 1 ||
      file.kdf !== 'scrypt' ||
      !file.kdfParams ||
      typeof file.salt !== 'string' ||
      typeof file.nonce !== 'string' ||
      typeof file.authTag !== 'string' ||
      typeof file.ciphertext !== 'string'
    ) {
      throw new EncryptedKeystoreError(
        'Keystore file is missing required fields or has unsupported version',
        'CORRUPT_FILE',
      );
    }

    const salt = Buffer.from(file.salt, 'base64');
    const nonce = Buffer.from(file.nonce, 'base64');
    const authTag = Buffer.from(file.authTag, 'base64');
    const ciphertext = Buffer.from(file.ciphertext, 'base64');

    if (salt.length !== SALT_LEN || nonce.length !== NONCE_LEN || authTag.length !== AUTH_TAG_LEN) {
      throw new EncryptedKeystoreError(
        'Keystore field lengths do not match expected sizes',
        'CORRUPT_FILE',
      );
    }

    const key = await scrypt(passphrase, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);

    try {
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      // Sanity: defend against degenerate-length payloads.
      if (plaintext.length === 0) {
        throw new EncryptedKeystoreError(
          'Decrypted payload is empty',
          'CORRUPT_FILE',
        );
      }
      // Constant-time touch on the derived key length to discourage compiler
      // dead-code elimination; not security-critical but cheap.
      timingSafeEqual(key, key);
      return new Uint8Array(plaintext);
    } catch (err) {
      if (err instanceof EncryptedKeystoreError) throw err;
      throw new EncryptedKeystoreError(
        'Invalid passphrase or corrupted keystore (authentication failed)',
        'INVALID_PASSPHRASE',
      );
    }
  }
}
