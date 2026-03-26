import { jest } from '@jest/globals';
/**
 * Sprint B — B4 Tests: downloadDataset function
 *
 * Tests for downloadDataset + getDatasetCacheDir in work-order-agent.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { downloadDataset, getDatasetCacheDir } from '../modules/agent/work-order-agent.js';

// Mock fetch globally
global.fetch = jest.fn();

const mockFetch = global.fetch as jest.Mock;

describe('B4 - downloadDataset', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    jest.resetAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapseia-node-b4-'));
    // Override HOME so the cache goes to tmpDir
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getDatasetCacheDir', () => {
    it('returns ~/.synapseia/datasets', () => {
      const dir = getDatasetCacheDir();
      expect(dir).toContain('.synapseia');
      expect(dir).toContain('datasets');
    });

    it('is based on homedir', () => {
      const dir = getDatasetCacheDir();
      expect(dir.startsWith(os.homedir())).toBe(true);
    });
  });

  describe('downloadDataset - fresh download', () => {
    it('downloads corpus and returns local path', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'TITLE: Test\nABSTRACT: Body\n\n',
        headers: { get: jest.fn().mockReturnValue(null) },
      });

      const localPath = await downloadDataset('http://coordinator:3000', 'medical');
      expect(localPath).toContain('corpus.txt');
      expect(localPath).toContain('medical');
      expect(fs.existsSync(localPath)).toBe(true);
    });

    it('writes downloaded content to file', async () => {
      const content = 'TITLE: Medical Paper\nABSTRACT: Some text\n\n';
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => content,
        headers: { get: jest.fn().mockReturnValue(null) },
      });

      const localPath = await downloadDataset('http://coordinator:3000', 'medical');
      expect(fs.readFileSync(localPath, 'utf-8')).toBe(content);
    });

    it('fetches from GET /datasets/{domain}/corpus', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'data',
        headers: { get: jest.fn().mockReturnValue(null) },
      });

      await downloadDataset('http://coordinator:3000', 'trading');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://coordinator:3000/datasets/trading/corpus',
        expect.any(Object),
      );
    });

    it('persists ETag metadata when server sends it', async () => {
      const etag = '"abc123"';
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'content',
        headers: { get: jest.fn((h: string) => (h === 'etag' ? etag : null)) },
      });

      await downloadDataset('http://coordinator:3000', 'ai');

      const metaPath = path.join(getDatasetCacheDir(), 'ai', 'cache-meta.json');
      expect(fs.existsSync(metaPath)).toBe(true);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { etag?: string };
      expect(meta.etag).toBe(etag);
    });

    it('persists Last-Modified metadata when server sends it', async () => {
      const lastModified = 'Wed, 26 Mar 2026 00:00:00 GMT';
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'content',
        headers: { get: jest.fn((h: string) => (h === 'last-modified' ? lastModified : null)) },
      });

      await downloadDataset('http://coordinator:3000', 'crypto');

      const metaPath = path.join(getDatasetCacheDir(), 'crypto', 'cache-meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { lastModified?: string };
      expect(meta.lastModified).toBe(lastModified);
    });
  });

  describe('downloadDataset - ETag caching', () => {
    it('sends If-None-Match header when ETag exists in cache', async () => {
      // Pre-populate cache
      const cacheDir = path.join(getDatasetCacheDir(), 'medical');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'corpus.txt'), 'old content');
      fs.writeFileSync(
        path.join(cacheDir, 'cache-meta.json'),
        JSON.stringify({ etag: '"old-etag-123"' }),
      );

      mockFetch.mockResolvedValue({
        ok: true,
        status: 304,
        text: async () => '',
        headers: { get: jest.fn().mockReturnValue(null) },
      });

      await downloadDataset('http://coordinator:3000', 'medical');

      const [, options] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(options.headers['If-None-Match']).toBe('"old-etag-123"');
    });

    it('returns cached path on 304 Not Modified', async () => {
      const cacheDir = path.join(getDatasetCacheDir(), 'medical');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'corpus.txt'), 'cached content');
      fs.writeFileSync(
        path.join(cacheDir, 'cache-meta.json'),
        JSON.stringify({ etag: '"etag-xyz"' }),
      );

      mockFetch.mockResolvedValue({
        ok: true,
        status: 304,
        text: async () => '',
        headers: { get: jest.fn().mockReturnValue(null) },
      });

      const localPath = await downloadDataset('http://coordinator:3000', 'medical');
      expect(localPath).toContain('corpus.txt');
      // Content should remain the cached version
      expect(fs.readFileSync(localPath, 'utf-8')).toBe('cached content');
    });

    it('does not re-download on 304 (no new write)', async () => {
      const cacheDir = path.join(getDatasetCacheDir(), 'finance');
      fs.mkdirSync(cacheDir, { recursive: true });
      const originalContent = 'original corpus data';
      fs.writeFileSync(path.join(cacheDir, 'corpus.txt'), originalContent);
      fs.writeFileSync(
        path.join(cacheDir, 'cache-meta.json'),
        JSON.stringify({ etag: '"etag-abc"' }),
      );

      mockFetch.mockResolvedValue({
        ok: true,
        status: 304,
        text: async () => 'should not appear',
        headers: { get: jest.fn().mockReturnValue(null) },
      });

      const localPath = await downloadDataset('http://coordinator:3000', 'finance');
      expect(fs.readFileSync(localPath, 'utf-8')).toBe(originalContent);
    });

    it('sends If-Modified-Since when only lastModified exists in cache', async () => {
      const cacheDir = path.join(getDatasetCacheDir(), 'trading');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'corpus.txt'), 'cached');
      fs.writeFileSync(
        path.join(cacheDir, 'cache-meta.json'),
        JSON.stringify({ lastModified: 'Mon, 01 Jan 2026 00:00:00 GMT' }),
      );

      mockFetch.mockResolvedValue({
        ok: true,
        status: 304,
        text: async () => '',
        headers: { get: jest.fn().mockReturnValue(null) },
      });

      await downloadDataset('http://coordinator:3000', 'trading');

      const [, options] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(options.headers['If-Modified-Since']).toBe('Mon, 01 Jan 2026 00:00:00 GMT');
    });
  });

  describe('downloadDataset - error handling', () => {
    it('returns cached file on network error if cache exists', async () => {
      const cacheDir = path.join(getDatasetCacheDir(), 'medical');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'corpus.txt'), 'cached corpus');

      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const localPath = await downloadDataset('http://coordinator:3000', 'medical');
      expect(fs.readFileSync(localPath, 'utf-8')).toBe('cached corpus');
    });

    it('throws on network error when no cache exists', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(downloadDataset('http://coordinator:3000', 'unknown-domain')).rejects.toThrow(
        /Failed to download dataset/,
      );
    });

    it('returns cached file when server returns non-OK and cache exists', async () => {
      const cacheDir = path.join(getDatasetCacheDir(), 'medical');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'corpus.txt'), 'cached');

      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Not found',
        headers: { get: jest.fn().mockReturnValue(null) },
      });

      const localPath = await downloadDataset('http://coordinator:3000', 'medical');
      expect(fs.existsSync(localPath)).toBe(true);
    });

    it('throws when server returns non-OK and no cache', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Not found',
        headers: { get: jest.fn().mockReturnValue(null) },
      });

      await expect(downloadDataset('http://coordinator:3000', 'no-cache-domain')).rejects.toThrow(
        /404/,
      );
    });

    it('ignores corrupt cache-meta.json without throwing', async () => {
      const cacheDir = path.join(getDatasetCacheDir(), 'medical');
      fs.mkdirSync(cacheDir, { recursive: true });
      // Write corrupt JSON
      fs.writeFileSync(path.join(cacheDir, 'cache-meta.json'), '{not-valid-json');

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'fresh content',
        headers: { get: jest.fn().mockReturnValue(null) },
      });

      const localPath = await downloadDataset('http://coordinator:3000', 'medical');
      expect(fs.readFileSync(localPath, 'utf-8')).toBe('fresh content');
    });
  });

  describe('downloadDataset - directory creation', () => {
    it('creates ~/.synapseia/datasets/{domain}/ directory', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'data',
        headers: { get: jest.fn().mockReturnValue(null) },
      });

      await downloadDataset('http://coordinator:3000', 'brand-new-domain');
      const cacheDir = path.join(getDatasetCacheDir(), 'brand-new-domain');
      expect(fs.existsSync(cacheDir)).toBe(true);
    });
  });
});
