import { detectInstallType, InstallType, attemptSelfUpdate } from '../utils/self-updater';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

jest.mock('child_process');
jest.mock('fs');
jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;

describe('detectInstallType', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('detects NPM_GLOBAL when package exists in npm root', () => {
    mockExecSync.mockReturnValue('/usr/local/lib/node_modules\n');
    mockExistsSync.mockImplementation((p: any) => {
      return String(p).includes('@synapseia/node/package.json');
    });
    expect(detectInstallType()).toBe(InstallType.NPM_GLOBAL);
  });

  it('detects GIT_CLONE when .git exists in package root', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not npm'); });
    mockExistsSync.mockImplementation((p: any) => {
      return String(p).endsWith('.git');
    });
    expect(detectInstallType()).toBe(InstallType.GIT_CLONE);
  });

  it('returns UNKNOWN when no install type matches', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not npm'); });
    mockExistsSync.mockReturnValue(false);
    expect(detectInstallType()).toBe(InstallType.UNKNOWN);
  });
});

describe('attemptSelfUpdate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('succeeds for NPM_GLOBAL install', () => {
    // detectInstallType -> NPM_GLOBAL
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd) === 'npm root -g') return '/usr/local/lib/node_modules\n';
      return ''; // npm install -g succeeds
    });
    mockExistsSync.mockImplementation((p: any) =>
      String(p).includes('@synapseia/node/package.json'),
    );

    const result = attemptSelfUpdate();
    expect(result.success).toBe(true);
    expect(result.installType).toBe(InstallType.NPM_GLOBAL);
  });

  it('fails gracefully for GIT_CLONE', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not npm'); });
    mockExistsSync.mockImplementation((p: any) => String(p).endsWith('.git'));

    const result = attemptSelfUpdate();
    expect(result.success).toBe(false);
    expect(result.installType).toBe(InstallType.GIT_CLONE);
    expect(result.message).toContain('git pull');
  });

  it('returns failure message for UNKNOWN install', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not npm'); });
    mockExistsSync.mockReturnValue(false);

    const result = attemptSelfUpdate();
    expect(result.success).toBe(false);
    expect(result.installType).toBe(InstallType.UNKNOWN);
  });

  it('handles npm update failure', () => {
    // First call = npm root -g (success), second call = npm install -g (fail)
    let callCount = 0;
    mockExecSync.mockImplementation((cmd: any) => {
      callCount++;
      if (String(cmd) === 'npm root -g') return '/usr/local/lib/node_modules\n';
      throw new Error('EACCES: permission denied');
    });
    mockExistsSync.mockImplementation((p: any) =>
      String(p).includes('@synapseia/node/package.json'),
    );

    const result = attemptSelfUpdate();
    expect(result.success).toBe(false);
    expect(result.message).toContain('EACCES');
  });
});
