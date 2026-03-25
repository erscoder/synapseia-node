/**
 * Sprint E Tests Part 2 — E8 (isDiLoCoWorkOrder) + E10 (model-downloader)
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _childProcess = childProcess; // suppress unused import warning

// ======================================================================
// E8: isDiLoCoWorkOrder + executeDiLoCoWorkOrder + uploadGradients
// ======================================================================
import {
  isDiLoCoWorkOrder,
  executeDiLoCoWorkOrder,
  uploadGradients,
  type WorkOrder,
} from '../modules/agent/work-order-agent.js';

function makeDiLoCoWO(overrides: Partial<WorkOrder> = {}): WorkOrder {
  const payload = {
    domain: 'ai',
    modelId: 'Qwen/Qwen2.5-7B',
    outerRound: 1,
    innerSteps: 10,
    datasetId: 'ai-corpus',
    deadline: Date.now() + 600000,
    hyperparams: { learningRate: 2e-4 },
  };
  return {
    id: 'wo_diloco_1',
    title: 'DiLoCo training: ai',
    description: JSON.stringify(payload),
    requiredCapabilities: ['diloco', 'gpu'],
    rewardAmount: '50.000000000',
    status: 'PENDING',
    creatorAddress: 'coordinator',
    createdAt: Math.floor(Date.now() / 1000),
    type: 'DILOCO_TRAINING' as WorkOrder['type'],
    ...overrides,
  };
}

describe('E8 — isDiLoCoWorkOrder', () => {
  it('returns true for DILOCO_TRAINING type', () => {
    expect(isDiLoCoWorkOrder(makeDiLoCoWO())).toBe(true);
  });

  it('returns true when description has all DiLoCo fields (any type)', () => {
    const wo = makeDiLoCoWO({ type: 'TRAINING' as WorkOrder['type'] });
    expect(isDiLoCoWorkOrder(wo)).toBe(true);
  });

  it('returns false for RESEARCH work order', () => {
    const wo: WorkOrder = {
      id: 'r1', title: 'Research', description: JSON.stringify({ title: 'Paper', abstract: 'Abstract' }),
      requiredCapabilities: [], rewardAmount: '5.000000000', status: 'PENDING',
      creatorAddress: 'creator', createdAt: Date.now(), type: 'RESEARCH',
    };
    expect(isDiLoCoWorkOrder(wo)).toBe(false);
  });

  it('returns false for invalid JSON description with non-DILOCO type', () => {
    const wo = makeDiLoCoWO({ description: 'not json', type: 'COMPUTATION' as WorkOrder['type'] });
    expect(isDiLoCoWorkOrder(wo)).toBe(false);
  });

  it('returns false when description is missing required DiLoCo fields', () => {
    const wo = makeDiLoCoWO({ description: JSON.stringify({ domain: 'ai' }), type: 'COMPUTATION' as WorkOrder['type'] });
    expect(isDiLoCoWorkOrder(wo)).toBe(false);
  });

  it('returns true even for description-only (no type)', () => {
    const wo = makeDiLoCoWO({ type: undefined as unknown as WorkOrder['type'] });
    expect(isDiLoCoWorkOrder(wo)).toBe(true);
  });
});

describe('E8 — executeDiLoCoWorkOrder', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('returns success=false for invalid payload JSON', async () => {
    const wo = makeDiLoCoWO({ description: 'invalid json' });
    const result = await executeDiLoCoWorkOrder(wo, 'http://localhost:3000', 'peer1', ['gpu', 'diloco']);
    expect(result.success).toBe(false);
    expect(result.result).toContain('Invalid');
  });

  it('returns a string result and boolean success', async () => {
    // With real python unavailable in test env, this should fail gracefully
    const wo = makeDiLoCoWO();
    const result = await executeDiLoCoWorkOrder(wo, 'http://localhost:3000', 'peer1', ['gpu', 'diloco']);
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.result).toBe('string');
  });
});

describe('E8 — uploadGradients', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('returns true on successful upload', async () => {
    const mockFetch = jest.fn(() => Promise.resolve({ ok: true } as Response));
    global.fetch = mockFetch as unknown as typeof fetch;
    const result = await uploadGradients('http://localhost:3000', 'ai', 'peer1', Buffer.from('data'));
    expect(result).toBe(true);
  });

  it('returns false on failed upload', async () => {
    const mockFetch = jest.fn(() => Promise.resolve({ ok: false, text: async () => 'error' } as Response));
    global.fetch = mockFetch as unknown as typeof fetch;
    const result = await uploadGradients('http://localhost:3000', 'ai', 'peer1', Buffer.from('data'));
    expect(result).toBe(false);
  });

  it('returns false on network error', async () => {
    const mockFetch = jest.fn(() => Promise.reject(new Error('Network error')));
    global.fetch = mockFetch as unknown as typeof fetch;
    const result = await uploadGradients('http://localhost:3000', 'ai', 'peer1', Buffer.from('data'));
    expect(result).toBe(false);
  });
});

// ======================================================================
// E10: model-downloader
// ======================================================================
import {
  ensureBaseModel,
  downloadAdapter,
  getModelCacheDir,
  getAdapterCacheDir,
  ModelDownloaderHelper,
  type ExecSyncFn,
} from '../modules/model/model-downloader.js';

describe('E10 — model-downloader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapseia-test-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Cleanup tmp dir
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('getModelCacheDir returns a path under ~/.synapseia/models', () => {
    const dir = getModelCacheDir();
    expect(dir).toContain('.synapseia');
    expect(dir).toContain('models');
  });

  it('getAdapterCacheDir returns a path under ~/.synapseia/adapters', () => {
    const dir = getAdapterCacheDir();
    expect(dir).toContain('.synapseia');
    expect(dir).toContain('adapters');
  });

  it('getModelCacheDir with custom homeDir', () => {
    const dir = getModelCacheDir('/custom/home');
    expect(dir).toBe(path.join('/custom/home', '.synapseia', 'models'));
  });

  it('getAdapterCacheDir with custom homeDir', () => {
    const dir = getAdapterCacheDir('/custom/home');
    expect(dir).toBe(path.join('/custom/home', '.synapseia', 'adapters'));
  });

  it('ensureBaseModel in testMode creates mock dir and returns path', async () => {
    const modelPath = await ensureBaseModel('Qwen/Qwen2.5-7B', true, tmpDir);
    expect(fs.existsSync(modelPath)).toBe(true);
    expect(fs.existsSync(path.join(modelPath, 'config.json'))).toBe(true);
  });

  it('ensureBaseModel returns cached path if already exists', async () => {
    const path1 = await ensureBaseModel('test-model', true, tmpDir);
    const path2 = await ensureBaseModel('test-model', true, tmpDir);
    expect(path1).toBe(path2);
  });

  it('ensureBaseModel sanitizes modelId for directory name', async () => {
    const modelPath = await ensureBaseModel('Org/Model-Name', true, tmpDir);
    expect(modelPath).toContain('Org__Model-Name');
  });

  it('downloadAdapter creates local directory and saves file', async () => {
    const localPath = path.join(tmpDir, 'adapter');
    const mockBuffer = Buffer.from('fake-adapter-weights');
    const mockFetch = jest.fn(() => Promise.resolve({
      ok: true,
      arrayBuffer: async () => mockBuffer.buffer,
    } as Response));
    global.fetch = mockFetch as unknown as typeof fetch;

    await downloadAdapter('http://coordinator/diloco/ai/weights', localPath);
    expect(fs.existsSync(path.join(localPath, 'adapter_weights.pkl'))).toBe(true);
  });

  it('downloadAdapter skips download if already cached', async () => {
    const localPath = path.join(tmpDir, 'cached-adapter');
    fs.mkdirSync(localPath, { recursive: true });
    fs.writeFileSync(path.join(localPath, 'adapter_weights.pkl'), 'existing');

    const mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    await downloadAdapter('http://coordinator/weights', localPath);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('downloadAdapter throws on network error', async () => {
    const localPath = path.join(tmpDir, 'fail-adapter');
    const mockFetch = jest.fn(() => Promise.reject(new Error('Network error')));
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(downloadAdapter('http://bad-url', localPath)).rejects.toThrow('Network error');
  });

  it('downloadAdapter throws on non-ok HTTP response', async () => {
    const localPath = path.join(tmpDir, 'http-fail-adapter');
    const mockFetch = jest.fn(() => Promise.resolve({ ok: false, status: 404 } as Response));
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(downloadAdapter('http://coordinator/weights', localPath)).rejects.toThrow('HTTP 404');
  });

  it('ModelDownloaderHelper methods work correctly', async () => {
    const helper = new ModelDownloaderHelper();
    const modelPath = await helper.ensureBaseModel('test/model', true, tmpDir);
    expect(fs.existsSync(modelPath)).toBe(true);
    expect(helper.getModelCacheDir(tmpDir)).toContain('models');
    expect(helper.getAdapterCacheDir(tmpDir)).toContain('adapters');
  });

  it('ensureBaseModel in non-test mode with execSync failure cleans up and throws', async () => {
    const failExecSync: ExecSyncFn = () => { throw new Error('huggingface_hub not found'); };
    await expect(ensureBaseModel('fail/model', false, tmpDir, failExecSync))
      .rejects.toThrow('Failed to download model');
  });

  it('ensureBaseModel downloadAdapter - ModelDownloaderHelper.downloadAdapter works', async () => {
    const localPath = path.join(tmpDir, 'helper-adapter');
    const mockFetch = jest.fn(() => Promise.resolve({
      ok: true,
      arrayBuffer: async () => Buffer.from('weights').buffer,
    } as Response));
    global.fetch = mockFetch as unknown as typeof fetch;
    const helper = new ModelDownloaderHelper();
    await helper.downloadAdapter('http://server/weights', localPath);
    expect(fs.existsSync(path.join(localPath, 'adapter_weights.pkl'))).toBe(true);
  });
});
