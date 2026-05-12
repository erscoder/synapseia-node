/**
 * Vina availability probe — used by the heartbeat capability builder to
 * decide whether to advertise the `docking` capability.
 *
 * The detector spawns `<vinaBin> --version` and `<obabelBin> -V`. We
 * test against system binaries that always succeed (`true`) or always
 * fail (`false`) instead of mocking child_process, because the source
 * uses a top-level `spawn` import that's hard to stub under ESM-mode
 * jest. The behaviour we care about (resolves true when both run with
 * exit 0; false otherwise) is what real Vina+obabel exhibit, so the
 * stand-in is faithful.
 *
 * Positive-only caching: a successful detection is sticky for the
 * process lifetime (same as `isPyTorchAvailable`). A negative result
 * retries on the next call so an operator can install Vina without a
 * node restart.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { isVinaAvailable, __resetVinaCacheForTests } from '../docker';

// `/usr/bin/true` and `/usr/bin/false` are POSIX standards. macOS ships
// both at `/usr/bin/`. Linux ships them at `/bin/` and `/usr/bin/`
// (usrmerge). Existence-test both, pick the one available on this host.
import { existsSync } from 'fs';
const TRUE_BIN = ['/usr/bin/true', '/bin/true'].find(existsSync)!;
const FALSE_BIN = ['/usr/bin/false', '/bin/false'].find(existsSync)!;

describe('isVinaAvailable', () => {
  beforeEach(() => {
    __resetVinaCacheForTests();
  });

  it('returns true when both vina and obabel binaries respond with exit 0', async () => {
    const result = await isVinaAvailable({
      vinaBin: TRUE_BIN,
      obabelBin: TRUE_BIN,
    });
    expect(result).toBe(true);
  });

  it('returns false when vina binary is missing or unusable', async () => {
    const result = await isVinaAvailable({
      vinaBin: FALSE_BIN,
      obabelBin: TRUE_BIN,
    });
    expect(result).toBe(false);
  });

  it('returns false when obabel binary is missing or unusable', async () => {
    const result = await isVinaAvailable({
      vinaBin: TRUE_BIN,
      obabelBin: FALSE_BIN,
    });
    expect(result).toBe(false);
  });

  it('returns false when the vina path does not exist on PATH', async () => {
    const result = await isVinaAvailable({
      vinaBin: '/nonexistent/__vina_not_here__',
      obabelBin: TRUE_BIN,
    });
    expect(result).toBe(false);
  });

  it('caches a positive detection across calls (no re-spawn on hot path)', async () => {
    // First call seeds the cache.
    const first = await isVinaAvailable({
      vinaBin: TRUE_BIN,
      obabelBin: TRUE_BIN,
    });
    expect(first).toBe(true);

    // Second call must return true even when we point at a failing
    // binary — the positive cache short-circuits the probe entirely.
    // This proves the cache exists and is used (without it the call
    // would re-probe FALSE_BIN and resolve to false).
    const second = await isVinaAvailable({
      vinaBin: FALSE_BIN,
      obabelBin: FALSE_BIN,
    });
    expect(second).toBe(true);
  });

  it('does NOT cache a negative detection — retries on next call', async () => {
    // First call: both bins fail → false, no cache write.
    const first = await isVinaAvailable({
      vinaBin: FALSE_BIN,
      obabelBin: FALSE_BIN,
    });
    expect(first).toBe(false);

    // Second call: both bins succeed → true. If negatives were cached
    // this would still be false.
    const second = await isVinaAvailable({
      vinaBin: TRUE_BIN,
      obabelBin: TRUE_BIN,
    });
    expect(second).toBe(true);
  });
});
