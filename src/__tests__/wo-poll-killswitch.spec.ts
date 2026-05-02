/**
 * Tier-2 §2.4.1 — `SYNAPSEIA_DISABLE_WO_POLL` killswitch.
 *
 * The killswitch lets operators opt their peer into gossipsub-only
 * work-order discovery. When the env var is set to `'true'` (case-
 * insensitive) the legacy HTTP `GET /work-orders/available` poll loop is
 * skipped at boot. Pushed work orders continue to flow because the
 * gossipsub `WORK_ORDER_AVAILABLE` handler is wired earlier in
 * `startNode()` and isn't gated by this flag.
 *
 * `node-runtime.ts` is hard to bring up in a unit test — it touches
 * libp2p, the heartbeat helper, GPU smoke test, telemetry — so we
 * isolated the killswitch in two pure helpers (`isWoPollDisabled` and
 * `maybeStartWorkOrderPoll`) and exercise those directly.
 *
 * Specs match the plan one-for-one:
 *   1. unset env  → loop starts.
 *   2. 'true'     → loop NOT started + info log fires mentioning the var.
 *   3. 'false'    → loop starts (only the literal 'true' triggers).
 *   4. 'TRUE'     → loop NOT started (case-insensitive match).
 */
import { describe, it, expect, jest } from '@jest/globals';
import { isWoPollDisabled, maybeStartWorkOrderPoll, sanitizeForLog } from '../node-runtime';

type StartFn = () => Promise<void>;

function makeArgs(rawWoPollFlag: string | undefined): {
  rawWoPollFlag: string | undefined;
  startLoop: jest.MockedFunction<StartFn>;
  log: jest.MockedFunction<(msg: string) => void>;
  onError: jest.MockedFunction<(err: Error) => void>;
} {
  return {
    rawWoPollFlag,
    startLoop: jest.fn<StartFn>().mockResolvedValue(undefined),
    log: jest.fn<(msg: string) => void>(),
    onError: jest.fn<(err: Error) => void>(),
  };
}

describe('isWoPollDisabled — pure helper', () => {
  it('returns false when env is undefined', () => {
    expect(isWoPollDisabled(undefined)).toBe(false);
  });

  it('returns false when env is empty string', () => {
    expect(isWoPollDisabled('')).toBe(false);
  });

  it("returns true on lowercase 'true'", () => {
    expect(isWoPollDisabled('true')).toBe(true);
  });

  it("returns true on uppercase 'TRUE' (case-insensitive)", () => {
    expect(isWoPollDisabled('TRUE')).toBe(true);
  });

  it("returns true on mixed-case 'True'", () => {
    expect(isWoPollDisabled('True')).toBe(true);
  });

  it('returns true when value has surrounding whitespace', () => {
    // Operators copy/paste from runbooks; trim is forgiving.
    expect(isWoPollDisabled('  true  ')).toBe(true);
  });

  it("returns false on the literal 'false'", () => {
    expect(isWoPollDisabled('false')).toBe(false);
  });

  it("returns false on '0', '1', 'yes', 'on'", () => {
    expect(isWoPollDisabled('0')).toBe(false);
    expect(isWoPollDisabled('1')).toBe(false);
    expect(isWoPollDisabled('yes')).toBe(false);
    expect(isWoPollDisabled('on')).toBe(false);
  });

  it("returns false on 'truthy' and 'truee' (substring guard)", () => {
    expect(isWoPollDisabled('truthy')).toBe(false);
    expect(isWoPollDisabled('truee')).toBe(false);
  });
});

describe('maybeStartWorkOrderPoll — branch wrapper', () => {
  it('starts the loop when env var is unset (existing behaviour)', () => {
    const args = makeArgs(undefined);
    const started = maybeStartWorkOrderPoll(args);
    expect(started).toBe(true);
    expect(args.startLoop).toHaveBeenCalledTimes(1);
    expect(args.log).not.toHaveBeenCalled();
  });

  it("starts the loop on explicit 'false' string", () => {
    const args = makeArgs('false');
    const started = maybeStartWorkOrderPoll(args);
    expect(started).toBe(true);
    expect(args.startLoop).toHaveBeenCalledTimes(1);
  });

  it("skips the loop and logs info on 'true'", () => {
    const args = makeArgs('true');
    const started = maybeStartWorkOrderPoll(args);
    expect(started).toBe(false);
    expect(args.startLoop).not.toHaveBeenCalled();
    expect(args.log).toHaveBeenCalledTimes(1);
    const [msg] = args.log.mock.calls[0];
    expect(msg).toContain('SYNAPSEIA_DISABLE_WO_POLL');
    expect(msg).toContain('disabled');
    expect(msg).toContain('gossipsub');
  });

  it("skips the loop on uppercase 'TRUE' (case-insensitive)", () => {
    const args = makeArgs('TRUE');
    const started = maybeStartWorkOrderPoll(args);
    expect(started).toBe(false);
    expect(args.startLoop).not.toHaveBeenCalled();
    expect(args.log).toHaveBeenCalledTimes(1);
    const [msg] = args.log.mock.calls[0];
    // The flag value is echoed in the log line so operators can confirm
    // their config landed — must be the post-sanitize value.
    expect(msg).toContain('SYNAPSEIA_DISABLE_WO_POLL=TRUE');
  });

  it('forwards startLoop rejections to onError without throwing', async () => {
    const args = makeArgs(undefined);
    const boom = new Error('langgraph crashed');
    args.startLoop.mockRejectedValueOnce(boom);
    expect(() => maybeStartWorkOrderPoll(args)).not.toThrow();
    // Wait a microtask so the .catch handler runs.
    await new Promise((r) => setImmediate(r));
    expect(args.onError).toHaveBeenCalledWith(boom);
  });

  it('does NOT call onError on the killswitch path (loop never started)', async () => {
    const args = makeArgs('true');
    maybeStartWorkOrderPoll(args);
    await new Promise((r) => setImmediate(r));
    expect(args.onError).not.toHaveBeenCalled();
  });
});

describe('sanitizeForLog — operator-controlled string guard', () => {
  it('strips CR / LF so a malicious env var cannot forge log lines', () => {
    const dirty = 'true\r\n[WO-Poll] forged-line';
    const safe = sanitizeForLog(dirty);
    expect(safe).not.toContain('\r');
    expect(safe).not.toContain('\n');
  });

  it('strips ANSI escape (ESC) bytes', () => {
    // \x1b[31mRED\x1b[0m
    const dirty = '\x1b[31mtrue\x1b[0m';
    const safe = sanitizeForLog(dirty);
    expect(safe).not.toContain('\x1b');
  });

  it('clamps absurdly long values to 64 chars + ellipsis', () => {
    const safe = sanitizeForLog('x'.repeat(10_000));
    // 64 visible chars + 1 ellipsis char.
    expect(safe.length).toBeLessThanOrEqual(65);
    expect(safe.endsWith('…')).toBe(true);
  });

  it('returns the value unchanged when it is already safe', () => {
    expect(sanitizeForLog('true')).toBe('true');
    expect(sanitizeForLog('TRUE')).toBe('TRUE');
  });
});
