import { checkVersion, UpdateStatus, fetchVersionInfo, preflightVersionCheck } from '../utils/update-checker';
import type { VersionInfo } from '../utils/update-checker';

// Mock version module
jest.mock('../utils/version', () => ({ getNodeVersion: () => '0.2.0' }));

// Mock logger
jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('checkVersion', () => {
  const baseInfo: VersionInfo = {
    protocolVersion: 1,
    minNodeVersion: '0.1.0',
    latestNodeVersion: '0.2.0',
    latestNodeUiVersion: '0.1.0',
  };

  it('returns UP_TO_DATE when current == latest', () => {
    const result = checkVersion('0.2.0', baseInfo);
    expect(result.status).toBe(UpdateStatus.UP_TO_DATE);
    expect(result.currentVersion).toBe('0.2.0');
  });

  it('returns UP_TO_DATE when current > latest', () => {
    const result = checkVersion('0.3.0', baseInfo);
    expect(result.status).toBe(UpdateStatus.UP_TO_DATE);
  });

  it('returns UPDATE_AVAILABLE when current > min but < latest', () => {
    const info = { ...baseInfo, latestNodeVersion: '0.3.0' };
    const result = checkVersion('0.2.0', info);
    expect(result.status).toBe(UpdateStatus.UPDATE_AVAILABLE);
    expect(result.latestVersion).toBe('0.3.0');
  });

  it('returns UPDATE_REQUIRED when current < min', () => {
    const info = { ...baseInfo, minNodeVersion: '0.3.0', latestNodeVersion: '0.4.0' };
    const result = checkVersion('0.2.0', info);
    expect(result.status).toBe(UpdateStatus.UPDATE_REQUIRED);
    expect(result.minVersion).toBe('0.3.0');
  });

  it('handles invalid semver by falling back to 0.0.0', () => {
    const result = checkVersion('not-a-version', baseInfo);
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

  it('returns version info on 200', async () => {
    const mockInfo: VersionInfo = {
      protocolVersion: 1,
      minNodeVersion: '0.1.0',
      latestNodeVersion: '0.2.0',
      latestNodeUiVersion: '0.1.0',
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockInfo),
    }) as any;

    const result = await fetchVersionInfo('http://localhost:3001');
    expect(result).toEqual(mockInfo);
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
});

describe('preflightVersionCheck', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns null when coordinator unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('down')) as any;
    const result = await preflightVersionCheck('http://localhost:3001');
    expect(result).toBeNull();
  });

  it('returns UP_TO_DATE when versions match', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        protocolVersion: 1,
        minNodeVersion: '0.1.0',
        latestNodeVersion: '0.2.0',
        latestNodeUiVersion: '0.1.0',
      }),
    }) as any;
    const result = await preflightVersionCheck('http://localhost:3001');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(UpdateStatus.UP_TO_DATE);
  });

  it('returns UPDATE_REQUIRED when below min', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        protocolVersion: 1,
        minNodeVersion: '1.0.0',
        latestNodeVersion: '1.0.0',
        latestNodeUiVersion: '0.1.0',
      }),
    }) as any;
    const result = await preflightVersionCheck('http://localhost:3001');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(UpdateStatus.UPDATE_REQUIRED);
  });
});
