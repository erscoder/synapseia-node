import { getNodeVersion } from '../version';

describe('getNodeVersion', () => {
  it('returns a valid semver string', () => {
    const version = getNodeVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns the same value on subsequent calls (cached)', () => {
    expect(getNodeVersion()).toBe(getNodeVersion());
  });
});
