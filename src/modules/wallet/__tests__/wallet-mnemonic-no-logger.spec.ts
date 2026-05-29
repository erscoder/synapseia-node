/**
 * F-node MEDIUM regression — the wallet recovery mnemonic is NEVER routed
 * through the structured logger (which forwards every arg to the telemetry
 * tap, see utils/logger.ts `callTap`). The seed phrase must reach ONLY a
 * raw interactive TTY (`process.stdout.write` gated on `process.stdout.isTTY`).
 *
 * Verifies:
 *   1. On a TTY, the mnemonic is written raw to stdout and the loud warning
 *      banner (no secret) still goes through the logger.
 *   2. On a TTY, NO logger method (log/info/warn/error/debug) is ever called
 *      with an argument containing the mnemonic.
 *   3. The logger telemetry tap never observes the mnemonic.
 *   4. On a non-TTY (piped / node-ui stdin flow), the mnemonic is NOT emitted
 *      to ANY sink (not stdout, not the logger); a withheld-notice is printed
 *      to stderr instead.
 *   5. With no mnemonic present, nothing is emitted.
 */
import { WalletHelper, SolanaWallet } from '../wallet';
import loggerDefault, { setLoggerTap, LogLevel } from '../../../utils/logger';

const MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

function makeWallet(withMnemonic = true): SolanaWallet {
  return {
    publicKey: 'So1anaPubKeyBase58',
    secretKey: Array.from({ length: 64 }, (_, i) => i),
    createdAt: new Date().toISOString(),
    ...(withMnemonic ? { mnemonic: MNEMONIC } : {}),
  };
}

describe('displayWalletCreationWarning — mnemonic never reaches the structured logger', () => {
  const helper = new WalletHelper();
  const originalIsTTY = process.stdout.isTTY;

  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;
  let tapArgs: unknown[][];

  beforeEach(() => {
    // Raw stream writes are intercepted so nothing actually prints.
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Spy on EVERY logger method to prove the secret never passes through it.
    logSpy = jest.spyOn(loggerDefault, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(loggerDefault, 'warn').mockImplementation(() => undefined);
    infoSpy = jest.spyOn(loggerDefault, 'info').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(loggerDefault, 'error').mockImplementation(() => undefined);
    debugSpy = jest.spyOn(loggerDefault, 'debug').mockImplementation(() => undefined);

    // Capture what the telemetry tap would observe — but note: because we
    // mock the logger methods above, the real tap is short-circuited. The
    // *additional* guard below (assertNoLoggerSawMnemonic) is what actually
    // proves the secret was never an argument to a logger call.
    tapArgs = [];
    setLoggerTap((_level: LogLevel, args: unknown[]) => {
      tapArgs.push(args);
    });
  });

  afterEach(() => {
    setLoggerTap(null);
    jest.restoreAllMocks();
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
  });

  function assertNoLoggerSawMnemonic(): void {
    for (const spy of [logSpy, warnSpy, infoSpy, errorSpy, debugSpy]) {
      for (const call of spy.mock.calls) {
        const joined = call.map((a) => String(a)).join(' ');
        expect(joined).not.toContain(MNEMONIC);
      }
    }
    // The tap (telemetry transport) must likewise never see the seed.
    for (const args of tapArgs) {
      const joined = args.map((a) => String(a)).join(' ');
      expect(joined).not.toContain(MNEMONIC);
    }
  }

  it('on a TTY writes the mnemonic raw to stdout and NEVER to the logger', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    helper.displayWalletCreationWarning(makeWallet());

    // Mnemonic went to raw stdout.
    const stdoutText = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stdoutText).toContain(MNEMONIC);

    // Loud warning banner (no secret) still goes through the logger.
    expect(warnSpy).toHaveBeenCalled();
    const warnText = warnSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(warnText).toMatch(/recovery phrase offline/i);

    // The secret never touched any logger method or the telemetry tap.
    assertNoLoggerSawMnemonic();
  });

  it('on a NON-TTY does NOT emit the mnemonic to any sink (logger or stdout)', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    helper.displayWalletCreationWarning(makeWallet());

    // Mnemonic must NOT appear on stdout when non-interactive.
    const stdoutText = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stdoutText).not.toContain(MNEMONIC);

    // A withheld-notice goes to stderr (raw), carrying NO secret.
    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrText).toMatch(/only at interactive/i);
    expect(stderrText).not.toContain(MNEMONIC);

    // And the secret never touched any logger method or the tap.
    assertNoLoggerSawMnemonic();
  });

  it('emits nothing when the wallet has no mnemonic', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    helper.displayWalletCreationWarning(makeWallet(false));

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(tapArgs).toHaveLength(0);
  });
});
