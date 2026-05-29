/**
 * Unit tests for the keystore-only `wallet-create` orchestration
 * (`cli/wallet-create.ts`).
 *
 * Contract under test (must match node-ui's `create_wallet` in
 * `src-tauri/src/commands.rs` — see module docstring):
 *   - A stdin/file passphrase creates the encrypted keystore, NEVER a
 *     wallet.json nor a wallet-backup.json, persists node name/model to
 *     config, prints `__WALLET_OK__ <base58-pubkey>`, exits 0.
 *   - A second invocation (keystore OR legacy wallet.json present) refuses
 *     with `WALLET_ALREADY_EXISTS` (exit 5).
 *   - A passphrase shorter than 8 chars → `PASSWORD_TOO_SHORT` (exit 2).
 *   - A missing passphrase → exit 2.
 *
 * The on-disk side effects are asserted by mocking `fs.existsSync` and the
 * EncryptedKeystore, then proving NO cleartext-write path is ever invoked.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  runWalletCreate,
  createKeypairIntoKeystore,
  type WalletCreateLogger,
  type WalletCreateConfig,
} from '../wallet-create';

function makeLogger() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } satisfies WalletCreateLogger;
}

/** In-memory keystore double that flips `exists()` true after `encrypt()`. */
function makeKeystore() {
  let written = false;
  return {
    encrypt: jest.fn(async () => {
      written = true;
    }),
    getPath: jest.fn(() => '/tmp/home/.synapseia/wallet.keystore.json'),
    exists: jest.fn(() => written),
  };
}

function makeConfigStore(initial: WalletCreateConfig = {}) {
  const cfg: WalletCreateConfig = { ...initial };
  return {
    cfg,
    load: jest.fn(() => cfg),
    save: jest.fn((next: WalletCreateConfig) => {
      Object.assign(cfg, next);
    }),
  };
}

function makeIdentityStore() {
  return { update: jest.fn() };
}

/**
 * Deterministic crypto provider double. The ESM-only deps (`@solana/web3.js`,
 * `bip39`, `ed25519-hd-key`) cannot be transformed by jest, so we inject a
 * fake that yields a real base58 32-byte pubkey + a 64-byte secret key. This
 * keeps the keypair-generation contract (64-byte secret, base58 address,
 * 12-word mnemonic) without loading the real crypto.
 */
function makeCrypto() {
  // 32 raw bytes → base58 (a valid Solana pubkey shape). All-zero bytes
  // encode to "11111111111111111111111111111111" (32 base58 ones).
  const address = '1'.repeat(32);
  const secretKey = new Uint8Array(64); // 64-byte ed25519 secret key
  const mnemonic =
    'legal winner thank year wave sausage worth useful legal winner thank yellow';
  return {
    generateMnemonic: jest.fn(() => mnemonic),
    deriveSeed32: jest.fn(async () => new Uint8Array(32)),
    keypairFromSeed32: jest.fn(() => ({ address, secretKey })),
    address,
    mnemonic,
  };
}

describe('createKeypairIntoKeystore', () => {
  it('encrypts a fresh BIP44 keypair into the keystore and returns a base58 address + mnemonic, persisting NOTHING in cleartext', async () => {
    const keystore = makeKeystore();
    const logger = makeLogger();
    const crypto = makeCrypto();

    const result = await createKeypairIntoKeystore('a-strong-passphrase', {
      keystore,
      logger,
      crypto,
    });

    // Keystore was written exactly once, with the passphrase + 64-byte key.
    expect(keystore.encrypt).toHaveBeenCalledTimes(1);
    const [secretArg, passArg] = keystore.encrypt.mock.calls[0] as [Uint8Array, string];
    expect(secretArg).toBeInstanceOf(Uint8Array);
    expect(secretArg.length).toBe(64); // Solana secretKey = 64 bytes
    expect(passArg).toBe('a-strong-passphrase');

    // Address is a valid 32..44 char base58 token; mnemonic is 12 words.
    expect(result.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(result.mnemonic.trim().split(/\s+/)).toHaveLength(12);

    // The mnemonic is printed ONCE for the operator to record.
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain(result.mnemonic);
  });
});

// `pathExists` is injected into runWalletCreate so the legacy-wallet.json
// guard is testable without mocking the frozen-by-ESM `fs` module (mocking
// it also breaks the dynamic `@solana/web3.js` import). `noFiles` = fresh
// install; `withLegacyWallet` = a wallet.json already on disk.
const noFiles = () => false;
const withLegacyWallet = (p: string) => p.endsWith('wallet.json');

describe('runWalletCreate', () => {
  it('creates the keystore, persists name/model, prints __WALLET_OK__, exits 0 — and NEVER writes wallet.json or wallet-backup.json', async () => {
    const keystore = makeKeystore();
    const configStore = makeConfigStore();
    const identityStore = makeIdentityStore();
    const logger = makeLogger();

    const result = await runWalletCreate(
      { name: 'node-alpha', model: 'ollama/llama3', llmKey: 'sk-test' },
      {
        passphrase: 'a-strong-passphrase',
        keystore,
        configStore,
        identityStore,
        logger,
        nodeHome: '/tmp/home/.synapseia',
        pathExists: noFiles,
        crypto: makeCrypto(),
      },
    );

    if (result.exitCode !== 0) {
      // Surface the swallowed error for diagnosis.
      throw new Error(`unexpected exit ${result.exitCode}: ${logger.error.mock.calls.map((c) => String(c[0])).join(' | ')}`);
    }
    expect(result.exitCode).toBe(0);
    expect(result.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

    // The encrypted keystore is the ONLY write the command performs.
    // (The module never imports writeFileSync — see the source-level guard
    // test below — so no wallet.json / wallet-backup.json can be created.)
    expect(keystore.encrypt).toHaveBeenCalledTimes(1);

    // Config persisted with name/model/llmKey.
    expect(configStore.save).toHaveBeenCalledTimes(1);
    expect(configStore.cfg.name).toBe('node-alpha');
    expect(configStore.cfg.defaultModel).toBe('ollama/llama3');
    expect(configStore.cfg.llmKey).toBe('sk-test');

    // identity.json kept in sync with the chosen name.
    expect(identityStore.update).toHaveBeenCalledWith(
      { name: 'node-alpha' },
      '/tmp/home/.synapseia',
    );

    // Exact stdout sentinel node-ui's extract_pubkey greps.
    const logged = logger.log.mock.calls.map((c) => String(c[0])).join('\n');
    const match = logged.match(/__WALLET_OK__\s+(\S+)/);
    expect(match?.[1]).toBe(result.address);
  });

  it('refuses with WALLET_ALREADY_EXISTS (exit 5) when a keystore already exists', async () => {
    const keystore = makeKeystore();
    keystore.exists.mockReturnValue(true); // second invocation
    const configStore = makeConfigStore();
    const identityStore = makeIdentityStore();
    const logger = makeLogger();

    const result = await runWalletCreate(
      { name: 'node-alpha' },
      {
        passphrase: 'a-strong-passphrase',
        keystore,
        configStore,
        identityStore,
        logger,
        nodeHome: '/tmp/home/.synapseia',
        pathExists: noFiles,
      },
    );

    expect(result.exitCode).toBe(5);
    expect(keystore.encrypt).not.toHaveBeenCalled();
    expect(configStore.save).not.toHaveBeenCalled();
    const errored = logger.error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errored).toContain('WALLET_ALREADY_EXISTS');
  });

  it('refuses with WALLET_ALREADY_EXISTS (exit 5) when a legacy wallet.json exists', async () => {
    const keystore = makeKeystore(); // keystore absent
    const logger = makeLogger();

    const result = await runWalletCreate(
      { name: 'node-alpha' },
      {
        passphrase: 'a-strong-passphrase',
        keystore,
        configStore: makeConfigStore(),
        identityStore: makeIdentityStore(),
        logger,
        nodeHome: '/tmp/home/.synapseia',
        pathExists: withLegacyWallet,
      },
    );

    expect(result.exitCode).toBe(5);
    expect(keystore.encrypt).not.toHaveBeenCalled();
  });

  it('rejects a passphrase shorter than 8 chars with PASSWORD_TOO_SHORT (exit 2)', async () => {
    const keystore = makeKeystore();
    const logger = makeLogger();

    const result = await runWalletCreate(
      { name: 'node-alpha' },
      {
        passphrase: 'short',
        keystore,
        configStore: makeConfigStore(),
        identityStore: makeIdentityStore(),
        logger,
        nodeHome: '/tmp/home/.synapseia',
      },
    );

    expect(result.exitCode).toBe(2);
    expect(keystore.encrypt).not.toHaveBeenCalled();
    const errored = logger.error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errored).toContain('PASSWORD_TOO_SHORT');
  });

  it('exits 2 when no passphrase is supplied', async () => {
    const keystore = makeKeystore();
    const logger = makeLogger();

    const result = await runWalletCreate(
      { name: 'node-alpha' },
      {
        passphrase: undefined,
        keystore,
        configStore: makeConfigStore(),
        identityStore: makeIdentityStore(),
        logger,
        nodeHome: '/tmp/home/.synapseia',
      },
    );

    expect(result.exitCode).toBe(2);
    expect(keystore.encrypt).not.toHaveBeenCalled();
  });

  it('warns that --llm-url is deprecated but still accepts it', async () => {
    const keystore = makeKeystore();
    const logger = makeLogger();

    const result = await runWalletCreate(
      { name: 'node-alpha', llmUrl: 'http://legacy:1234' },
      {
        passphrase: 'a-strong-passphrase',
        keystore,
        configStore: makeConfigStore(),
        identityStore: makeIdentityStore(),
        logger,
        nodeHome: '/tmp/home/.synapseia',
        pathExists: noFiles,
        crypto: makeCrypto(),
      },
    );

    expect(result.exitCode).toBe(0);
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('--llm-url is deprecated');
  });
});

describe('wallet-create source-level cleartext-write guard', () => {
  it('the module CODE imports no plaintext-write API and references no backup path', () => {
    // The strongest proof that this command can NEVER persist a cleartext
    // wallet is that the source CODE has no write API and no backup-path
    // string. (`createKeypairIntoKeystore` already proved the keystore is
    // the sole sink for the secret key.) Strip comments first — the
    // docstring intentionally MENTIONS wallet-backup.json / writeFileSync
    // when explaining what the command does NOT do.
    const raw = readFileSync(join(__dirname, '..', 'wallet-create.ts'), 'utf-8');
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (keep `://` in URLs)
    expect(code).not.toMatch(/\bwriteFileSync\b/);
    expect(code).not.toMatch(/wallet-backup/);
    // The only `wallet.json` mention in CODE is the read-only existence guard.
    const walletJsonRefs = code.match(/wallet\.json/g) ?? [];
    expect(walletJsonRefs.length).toBeLessThanOrEqual(1);
  });
});
