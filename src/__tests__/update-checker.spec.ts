import {
  checkVersion,
  UpdateStatus,
  fetchVersionInfo,
  fetchNpmLatest,
  preflightVersionCheck,
} from '../utils/update-checker';
import type { VersionInfo } from '../utils/update-checker';

// Mock version module
jest.mock('../utils/version', () => ({ getNodeVersion: () => '0.2.0' }));

// Mock logger
jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import logger from '../utils/logger';

describe('checkVersion', () => {
  const baseInfo: VersionInfo = {
    protocolVersion: 1,
    minNodeVersion: '0.1.0',
  };

  it('returns UP_TO_DATE when current == latest', () => {
    const result = checkVersion('0.2.0', baseInfo, '0.2.0');
    expect(result.status).toBe(UpdateStatus.UP_TO_DATE);
    expect(result.currentVersion).toBe('0.2.0');
  });

  it('returns UP_TO_DATE when current > latest', () => {
    const result = checkVersion('0.3.0', baseInfo, '0.2.0');
    expect(result.status).toBe(UpdateStatus.UP_TO_DATE);
  });

  it('returns UPDATE_AVAILABLE when current > min but < latest', () => {
    const result = checkVersion('0.2.0', baseInfo, '0.3.0');
    expect(result.status).toBe(UpdateStatus.UPDATE_AVAILABLE);
    expect(result.latestVersion).toBe('0.3.0');
  });

  it('returns UPDATE_REQUIRED when current < min', () => {
    const info = { ...baseInfo, minNodeVersion: '0.3.0' };
    const result = checkVersion('0.2.0', info, '0.4.0');
    expect(result.status).toBe(UpdateStatus.UPDATE_REQUIRED);
    expect(result.minVersion).toBe('0.3.0');
  });

  it('handles invalid semver by falling back to 0.0.0', () => {
    const result = checkVersion('not-a-version', baseInfo, '0.2.0');
    expect(result.currentVersion).toBe('0.0.0');
    // 0.0.0 < minNodeVersion 0.1.0 = required
    expect(result.status).toBe(UpdateStatus.UPDATE_REQUIRED);
  });
});

describe('fetchVersionInfo', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns version info on 200 with required fields', async () => {
    const payload = {
      protocolVersion: 1,
      minNodeVersion: '0.1.0',
      // Extra/legacy fields the coord may still emit are ignored.
      latestNodeVersion: '0.2.0',
      latestNodeUiVersion: '0.1.0',
      latestVersion: '0.2.0',
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(payload),
    }) as any;

    const result = await fetchVersionInfo('http://localhost:3001');
    expect(result).toEqual({ protocolVersion: 1, minNodeVersion: '0.1.0' });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3001/version',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns null on non-200', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as any;
    const result = await fetchVersionInfo('http://localhost:3001');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
    const result = await fetchVersionInfo('http://localhost:3001');
    expect(result).toBeNull();
  });

  it('returns null when required fields are missing or wrong type', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ minNodeVersion: '0.1.0' }),
    }) as any;
    expect(await fetchVersionInfo('http://localhost:3001')).toBeNull();

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ protocolVersion: '1', minNodeVersion: '0.1.0' }),
    }) as any;
    expect(await fetchVersionInfo('http://localhost:3001')).toBeNull();
  });
});

describe('preflightVersionCheck', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  /** Helper: route fetch by URL so we can stub npm and coord independently. */
  function stubFetch(opts: {
    npm?: { ok: boolean; latest?: string } | 'reject';
    coord?: { ok: boolean; body?: any } | 'reject';
  }) {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('registry.npmjs.org')) {
        if (opts.npm === 'reject') return Promise.reject(new Error('npm down'));
        if (!opts.npm) return Promise.resolve({ ok: false });
        return Promise.resolve({
          ok: opts.npm.ok,
          json: () => Promise.resolve(opts.npm!.latest ? { latest: opts.npm!.latest } : {}),
        });
      }
      // coordinator
      if (opts.coord === 'reject') return Promise.reject(new Error('coord down'));
      if (!opts.coord) return Promise.resolve({ ok: false });
      return Promise.resolve({
        ok: opts.coord.ok,
        json: () => Promise.resolve(opts.coord!.body ?? {}),
      });
    }) as any;
  }

  it('uses npm latest when npm is up (coord latest is never consulted)', async () => {
    stubFetch({
      npm: { ok: true, latest: '0.2.0' },
      coord: {
        ok: true,
        body: {
          protocolVersion: 1,
          minNodeVersion: '0.1.0',
          // even if a legacy coord still serves these, they MUST be ignored.
          latestNodeVersion: '99.0.0',
          latestNodeUiVersion: '99.0.0',
          latestVersion: '99.0.0',
        },
      },
    });
    const result = await preflightVersionCheck('http://localhost:3001');
    expect(result).not.toBeNull();
    expect(result!.latestVersion).toBe('0.2.0');
    expect(result!.status).toBe(UpdateStatus.UP_TO_DATE);
  });

  it('returns null and WARNs when npm is unreachable (no coord fallback)', async () => {
    stubFetch({
      npm: 'reject',
      coord: {
        ok: true,
        body: { protocolVersion: 1, minNodeVersion: '0.1.0', latestNodeVersion: '0.2.0' },
      },
    });
    const result = await preflightVersionCheck('http://localhost:3001');
    expect(result).toBeNull();
    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('npm registry unreachable'),
    );
  });

  it('returns null when npm returns non-2xx (no coord fallback)', async () => {
    stubFetch({
      npm: { ok: false },
      coord: {
        ok: true,
        body: { protocolVersion: 1, minNodeVersion: '0.1.0', latestNodeVersion: '0.2.0' },
      },
    });
    const result = await preflightVersionCheck('http://localhost:3001');
    expect(result).toBeNull();
  });

  it('reads minNodeVersion from coord, latest from npm', async () => {
    stubFetch({
      npm: { ok: true, latest: '1.0.0' },
      coord: { ok: true, body: { protocolVersion: 1, minNodeVersion: '1.0.0' } },
    });
    const result = await preflightVersionCheck('http://localhost:3001');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(UpdateStatus.UPDATE_REQUIRED);
    expect(result!.minVersion).toBe('1.0.0');
    expect(result!.latestVersion).toBe('1.0.0');
  });

  it('falls back minVersion to 0.0.0 when coord is down but npm is up', async () => {
    stubFetch({
      npm: { ok: true, latest: '0.2.0' },
      coord: 'reject',
    });
    const result = await preflightVersionCheck('http://localhost:3001');
    expect(result).not.toBeNull();
    expect(result!.minVersion).toBe('0.0.0');
    expect(result!.status).toBe(UpdateStatus.UP_TO_DATE);
  });

  it('UPDATE_AVAILABLE when npm latest > local', async () => {
    stubFetch({
      npm: { ok: true, latest: '0.3.0' },
      coord: { ok: true, body: { protocolVersion: 1, minNodeVersion: '0.1.0' } },
    });
    const result = await preflightVersionCheck('http://localhost:3001');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(UpdateStatus.UPDATE_AVAILABLE);
    expect(result!.latestVersion).toBe('0.3.0');
  });
});

describe('fetchNpmLatest', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns the latest version when registry serves valid semver', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ latest: '0.9.0' }),
    }) as any;
    expect(await fetchNpmLatest()).toBe('0.9.0');
  });

  it('returns null when registry returns invalid semver', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ latest: 'banana' }),
    }) as any;
    expect(await fetchNpmLatest()).toBeNull();
  });

  it('returns null on network failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('boom')) as any;
    expect(await fetchNpmLatest()).toBeNull();
  });
});
