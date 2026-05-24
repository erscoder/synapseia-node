/**
 * Spec for the subprocess env sanitiser (F-node-008 / NIT-3).
 *
 * The denylist is the node's defence-in-depth boundary: any child the node
 * spawns (python trainer / validator / aggregator, ollama, external bins)
 * inherits the parent env by default, so wallet secrets AND AWS bucket
 * credentials must be stripped before they cross the spawn boundary.
 */
import { sanitizedEnvForSubprocess, SENSITIVE_ENV_VARS } from '../subprocess-env';

describe('sanitizedEnvForSubprocess', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    // Fresh, fully-controlled env per test so we never depend on the
    // ambient CI env (which may or may not export AWS_* itself).
    process.env = {};
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('strips wallet / keystore secrets (regression)', () => {
    process.env.SYNAPSEIA_WALLET_PASSWORD = 'pw';
    process.env.WALLET_PASSWORD = 'pw-legacy';
    process.env.SYNAPSEIA_KEYSTORE_PASSPHRASE = 'kp';
    process.env.SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE = '/run/secrets/kp';
    process.env.SYNAPSEIA_WALLET_MNEMONIC = 'word '.repeat(12).trim();

    const env = sanitizedEnvForSubprocess();

    expect(env.SYNAPSEIA_WALLET_PASSWORD).toBeUndefined();
    expect(env.WALLET_PASSWORD).toBeUndefined();
    expect(env.SYNAPSEIA_KEYSTORE_PASSPHRASE).toBeUndefined();
    expect(env.SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE).toBeUndefined();
    expect(env.SYNAPSEIA_WALLET_MNEMONIC).toBeUndefined();
  });

  it('strips AWS credentials so a spawned child cannot exfiltrate them (NIT-3)', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    process.env.AWS_SESSION_TOKEN = 'token';

    const env = sanitizedEnvForSubprocess();

    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
  });

  it('declares AWS credentials in the denylist constant', () => {
    expect(SENSITIVE_ENV_VARS).toEqual(
      expect.arrayContaining(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']),
    );
  });

  it('preserves non-sensitive env vars (e.g. PATH, AWS bucket name)', () => {
    process.env.PATH = '/usr/bin';
    // The bucket NAME is not a credential — it must NOT be stripped.
    process.env.AWS_DILOCO_BUCKET = 'synapseia-diloco';
    process.env.AWS_REGION = 'eu-west-1';

    const env = sanitizedEnvForSubprocess();

    expect(env.PATH).toBe('/usr/bin');
    expect(env.AWS_DILOCO_BUCKET).toBe('synapseia-diloco');
    expect(env.AWS_REGION).toBe('eu-west-1');
  });

  it('merges `extra` on top of the sanitised clone', () => {
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    process.env.PATH = '/usr/bin';

    const env = sanitizedEnvForSubprocess({ OMP_NUM_THREADS: '4', CUDA_VISIBLE_DEVICES: '' });

    expect(env.OMP_NUM_THREADS).toBe('4');
    expect(env.CUDA_VISIBLE_DEVICES).toBe('');
    expect(env.PATH).toBe('/usr/bin');
    // `extra` must not re-introduce a stripped secret.
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('does not mutate process.env', () => {
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    sanitizedEnvForSubprocess();
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe('secret');
  });
});
