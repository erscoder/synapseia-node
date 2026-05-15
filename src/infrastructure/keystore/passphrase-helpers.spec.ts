/**
 * passphrase-helpers unit tests.
 *
 * Coverage:
 *  - env var unset → undefined (interactive prompt path)
 *  - file missing → undefined + warn log
 *  - file empty → undefined + warn log
 *  - insecure mode (0644) on Unix → undefined + warn log
 *  - happy path: 0600 file, owned by current uid → returns trimmed passphrase
 *  - trailing newline stripped
 */

import { promises as fs, chmodSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readPassphraseFromFile, PassphraseLogger } from './passphrase-helpers';

function makeLogger(): PassphraseLogger & {
  warnings: string[];
  logs: string[];
  errors: string[];
} {
  const warnings: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    warnings,
    logs,
    errors,
    log: (m: string) => logs.push(m),
    warn: (m: string) => warnings.push(m),
    error: (m: string) => errors.push(m),
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'synapseia-passphrase-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('readPassphraseFromFile', () => {
  it('returns undefined when env var is unset', async () => {
    const logger = makeLogger();
    expect(await readPassphraseFromFile(undefined, logger)).toBeUndefined();
    expect(logger.warnings).toHaveLength(0);
  });

  it('returns undefined when env var is empty / whitespace-only', async () => {
    const logger = makeLogger();
    expect(await readPassphraseFromFile('', logger)).toBeUndefined();
    expect(await readPassphraseFromFile('   ', logger)).toBeUndefined();
    expect(logger.warnings).toHaveLength(0);
  });

  it('returns undefined and warns when the file does not exist', async () => {
    const logger = makeLogger();
    const missing = path.join(tmpDir, 'missing.txt');
    expect(await readPassphraseFromFile(missing, logger)).toBeUndefined();
    expect(logger.warnings[0]).toMatch(/non-existent path/);
  });

  it('returns undefined and warns when the file is empty', async () => {
    const logger = makeLogger();
    const filePath = path.join(tmpDir, 'empty.txt');
    await fs.writeFile(filePath, '', { mode: 0o600 });
    expect(await readPassphraseFromFile(filePath, logger)).toBeUndefined();
    expect(logger.warnings[0]).toMatch(/is empty/);
  });

  it('returns the trimmed passphrase on the happy path (0600, current uid)', async () => {
    if (process.platform === 'win32') return;
    const logger = makeLogger();
    const filePath = path.join(tmpDir, 'pass.txt');
    await fs.writeFile(filePath, 'super-secret-passphrase-12345\n', { mode: 0o600 });
    chmodSync(filePath, 0o600);
    expect(await readPassphraseFromFile(filePath, logger)).toBe('super-secret-passphrase-12345');
    expect(logger.warnings).toHaveLength(0);
  });

  it('strips only a single trailing newline (preserves other whitespace)', async () => {
    if (process.platform === 'win32') return;
    const logger = makeLogger();
    const filePath = path.join(tmpDir, 'pass-ws.txt');
    await fs.writeFile(filePath, '  spaced-passphrase  \n', { mode: 0o600 });
    chmodSync(filePath, 0o600);
    expect(await readPassphraseFromFile(filePath, logger)).toBe('  spaced-passphrase  ');
  });

  it('returns undefined and warns when the file has insecure mode (0644) on Unix', async () => {
    if (process.platform === 'win32') return;
    const logger = makeLogger();
    const filePath = path.join(tmpDir, 'loose.txt');
    await fs.writeFile(filePath, 'secret', { mode: 0o644 });
    chmodSync(filePath, 0o644);
    expect(await readPassphraseFromFile(filePath, logger)).toBeUndefined();
    expect(logger.warnings[0]).toMatch(/insecure mode/);
  });
});
