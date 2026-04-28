import {
  normalizePaths,
  redactSecrets,
  sanitizeText,
  sanitizeContext,
  sanitizeEvent,
  truncateUtf8,
  SANITIZER_LIMITS,
} from '../sanitizer';

describe('normalizePaths', () => {
  it('rewrites macOS-style absolute paths to ~', () => {
    expect(normalizePaths('/Users/alice/clawd/projects/x.ts:1:1'))
      .toBe('~/clawd/projects/x.ts:1:1');
  });

  it('rewrites linux home paths', () => {
    expect(normalizePaths('/home/bob/work/file.ts')).toBe('~/work/file.ts');
  });

  it('rewrites docker /app/packages style paths', () => {
    expect(normalizePaths('/app/packages/node/src/x.ts'))
      .toBe('packages/node/src/x.ts');
  });

  it('does not touch already-relative paths', () => {
    expect(normalizePaths('packages/node/src/foo.ts'))
      .toBe('packages/node/src/foo.ts');
  });
});

describe('redactSecrets', () => {
  it('redacts `wallet=...` style assignments', () => {
    const out = redactSecrets('crash with wallet=4xKW9pdR1y2g3hN8 token=abc');
    expect(out).not.toMatch(/4xKW9pdR1y2g3hN8/);
    expect(out).toContain('wallet=<redacted>');
    expect(out).toContain('token=<redacted>');
  });

  it('keeps innocuous text untouched', () => {
    const s = 'submitted 5 events to coordinator';
    expect(redactSecrets(s)).toBe(s);
  });

  it('redacts mnemonic / privateKey / password labels', () => {
    expect(redactSecrets('mnemonic=cat dog horse rabbit eat fly'))
      .toContain('mnemonic=<redacted>');
    expect(redactSecrets('private=foo'))
      .toContain('private=<redacted>');
    expect(redactSecrets('password=hunter2'))
      .toContain('password=<redacted>');
  });
});

describe('truncateUtf8', () => {
  it('returns short strings unchanged', () => {
    expect(truncateUtf8('hello', 1024)).toBe('hello');
  });

  it('truncates and appends ellipsis when over budget', () => {
    const s = 'x'.repeat(5000);
    const out = truncateUtf8(s, 100);
    expect(out.length).toBeLessThanOrEqual(101);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('sanitizeText', () => {
  it('runs the full pipeline and truncates', () => {
    const input =
      '/Users/alice/x.ts:1:1 wallet=4xKW9pdR1y2g3hN8 ' + 'A'.repeat(5000);
    const out = sanitizeText(input, 100);
    expect(out).toContain('~');
    expect(out).not.toContain('/Users/alice/');
    expect(out).toContain('wallet=<redacted>');
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('sanitizeContext', () => {
  it('redacts keys that match sensitive patterns', () => {
    const out = sanitizeContext({
      foo: 'bar',
      WALLET_PRIVATE_KEY: '4xKW9pdR1y2g3hN8',
      apiKey: 'abcdef',
      nested: { SECRET_TOKEN: 'shouldgo', stillHere: 'ok' },
    }) as Record<string, unknown>;
    expect(out.WALLET_PRIVATE_KEY).toBe('<redacted>');
    expect((out.nested as Record<string, unknown>).SECRET_TOKEN).toBe('<redacted>');
    expect((out.nested as Record<string, unknown>).stillHere).toBe('ok');
  });

  it('caps array length to 50 items', () => {
    const out = sanitizeContext(Array(100).fill('x')) as unknown[];
    expect(out.length).toBe(50);
  });

  it('handles deeply-nested objects without infinite recursion', () => {
    let cursor: Record<string, unknown> = {};
    const root: Record<string, unknown> = cursor;
    for (let i = 0; i < 12; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const out = sanitizeContext(root);
    expect(out).toBeDefined();
  });
});

describe('sanitizeEvent', () => {
  it('returns a sanitized copy of an event', () => {
    const ev = {
      message: 'oops at /Users/alice/x.ts:42 wallet=4xKW9pdR1y2g3hN8',
      stack: 'TypeError: blah\n    at foo (/Users/alice/y.ts:1:1)',
      context: {
        WALLET_PRIVATE_KEY: 'should-be-redacted',
        normal: 'kept',
      },
    };
    const out = sanitizeEvent(ev);
    expect(out).not.toBeNull();
    expect(out!.message).toContain('~');
    expect(out!.message).toContain('wallet=<redacted>');
    expect(out!.stack).toContain('~');
    expect((out!.context as Record<string, unknown>).WALLET_PRIVATE_KEY).toBe('<redacted>');
    expect((out!.context as Record<string, unknown>).normal).toBe('kept');
  });

  it('truncates oversized context to a stub', () => {
    // Many top-level keys with short values — escapes per-leaf
    // truncation but exceeds MAX_CONTEXT_BYTES in aggregate (the
    // sanitizer caps at 50 keys, so use 50 with values ≥ 100 bytes).
    const huge: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) huge[`k${i}`] = 'A'.repeat(200);
    const ev = { message: 'm', stack: null, context: huge };
    const out = sanitizeEvent(ev);
    expect(out).not.toBeNull();
    expect((out!.context as Record<string, unknown>)._truncated).toBe(true);
  });

  it('truncates oversized message to MAX_MESSAGE_BYTES', () => {
    const ev = {
      message: 'A'.repeat(SANITIZER_LIMITS.MAX_MESSAGE_BYTES * 4),
      stack: null,
      context: {},
    };
    const out = sanitizeEvent(ev);
    expect(out).not.toBeNull();
    expect(Buffer.byteLength(out!.message, 'utf8')).toBeLessThanOrEqual(
      SANITIZER_LIMITS.MAX_MESSAGE_BYTES,
    );
  });
});

describe('regression — never leaks known secret patterns', () => {
  // Hard-fail test: if any of these strings survives sanitization,
  // we shipped a regression.
  const FORBIDDEN = [
    /\/Users\/[a-z]+\//i,
    /\/home\/[a-z]+\//i,
    /WALLET_PRIVATE_KEY=[a-zA-Z0-9]+/,
  ];

  it('regex blocklist passes for a representative event', () => {
    const ev = sanitizeEvent({
      message:
        'crash at /Users/alice/x.ts WALLET_PRIVATE_KEY=4xKW9pdR1y2g3hN8 / wallet=foo',
      stack: 'Error: at /home/bob/y.ts',
      context: { WALLET_PRIVATE_KEY: 'leak' },
    });
    const json = JSON.stringify(ev);
    for (const re of FORBIDDEN) {
      expect(json).not.toMatch(re);
    }
  });
});
