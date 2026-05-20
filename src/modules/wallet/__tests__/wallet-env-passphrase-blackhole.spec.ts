/**
 * F-node-008 (max-security) regression — env-var wallet passphrase is
 * NEVER honoured, no opt-in path remains.
 *
 * Verifies:
 *   1. `WalletHelper.promptForPassword()` does NOT short-circuit when
 *      `SYNAPSEIA_WALLET_PASSWORD` or `WALLET_PASSWORD` is set; it
 *      falls through to the interactive prompt (which we mock).
 *   2. The historical opt-in flag
 *      `SYNAPSEIA_ALLOW_INSECURE_ENV_PASSPHRASE=true` does NOT
 *      re-enable the env channel.
 *   3. Detection of the forbidden env vars writes a loud warning to
 *      stderr so the operator sees the misconfiguration.
 *   4. `WalletHelper.promptForNewPassword()` has the same hardening.
 */
import { WalletHelper } from '../wallet';

// Inquirer is dynamically imported inside the wallet module; jest's
// `unstable_mockModule` style is awkward in CJS so we mock it the
// classic way against the resolved module path.
jest.mock('@inquirer/prompts', () => ({
  password: jest.fn(),
}));

describe('F-node-008 — env-var wallet passphrase is blackholed', () => {
  const SAVED = { ...process.env };
  let stderrSpy: jest.SpyInstance;
  let mockedPasswordPrompt: jest.Mock;

  beforeEach(async () => {
    process.env = { ...SAVED };
    delete process.env.SYNAPSEIA_WALLET_PASSWORD;
    delete process.env.WALLET_PASSWORD;
    delete process.env.SYNAPSEIA_ALLOW_INSECURE_ENV_PASSPHRASE;
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const inquirer = await import('@inquirer/prompts');
    mockedPasswordPrompt = inquirer.password as unknown as jest.Mock;
    mockedPasswordPrompt.mockReset();
    mockedPasswordPrompt.mockResolvedValue('interactive-pass');
  });

  afterEach(() => {
    process.env = { ...SAVED };
    stderrSpy.mockRestore();
  });

  it('promptForPassword IGNORES SYNAPSEIA_WALLET_PASSWORD and falls through to TTY prompt', async () => {
    process.env.SYNAPSEIA_WALLET_PASSWORD = 'should-be-ignored';
    const helper = new WalletHelper();
    const result = await helper.promptForPassword('msg');
    expect(result).toBe('interactive-pass');
    expect(mockedPasswordPrompt).toHaveBeenCalledTimes(1);
    // stderr must carry the security warning so operators see it.
    const stderrCalls = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .join('');
    expect(stderrCalls).toMatch(/SYNAPSEIA_WALLET_PASSWORD/);
    expect(stderrCalls).toMatch(/never honoured/i);
  });

  it('promptForPassword IGNORES legacy WALLET_PASSWORD env var', async () => {
    process.env.WALLET_PASSWORD = 'legacy-should-be-ignored';
    const helper = new WalletHelper();
    const result = await helper.promptForPassword();
    expect(result).toBe('interactive-pass');
    expect(mockedPasswordPrompt).toHaveBeenCalledTimes(1);
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).toMatch(/WALLET_PASSWORD/);
  });

  it('opt-in flag SYNAPSEIA_ALLOW_INSECURE_ENV_PASSPHRASE=true does NOT re-enable env passphrase', async () => {
    process.env.SYNAPSEIA_WALLET_PASSWORD = 'still-ignored';
    process.env.SYNAPSEIA_ALLOW_INSECURE_ENV_PASSPHRASE = 'true';
    const helper = new WalletHelper();
    const result = await helper.promptForPassword();
    // Must STILL fall through to the prompt — the opt-in is gone.
    expect(result).toBe('interactive-pass');
    expect(mockedPasswordPrompt).toHaveBeenCalledTimes(1);
  });

  it('promptForNewPassword also ignores env-var passphrase and runs the create flow interactively', async () => {
    process.env.SYNAPSEIA_WALLET_PASSWORD = 'still-ignored-create';
    // promptForNewPassword loops until pass1 === pass2.
    mockedPasswordPrompt
      .mockResolvedValueOnce('matched-pass')
      .mockResolvedValueOnce('matched-pass');
    const helper = new WalletHelper();
    const result = await helper.promptForNewPassword();
    expect(result).toBe('matched-pass');
    // Two prompts: create + confirm.
    expect(mockedPasswordPrompt).toHaveBeenCalledTimes(2);
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).toMatch(/SYNAPSEIA_WALLET_PASSWORD/);
  });

  it('no warning is emitted when neither env var is set', async () => {
    const helper = new WalletHelper();
    await helper.promptForPassword();
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).not.toMatch(/SYNAPSEIA_WALLET_PASSWORD/);
    expect(stderrCalls).not.toMatch(/WALLET_PASSWORD/);
  });
});
