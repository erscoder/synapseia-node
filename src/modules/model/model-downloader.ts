/**
 * Model Downloader — handles downloading and caching of foundation models and LoRA adapters
 */

import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import logger from '../../utils/logger';
import { resolvePython } from '../../utils/python-venv';

export type ExecSyncFn = (cmd: string, options?: Record<string, unknown>) => void;

/**
 * F-node-005 — raised when an adapter download cannot be cryptographically
 * verified against the expected sha256 (or when the expected hash is
 * missing / malformed). Fail-closed: the trainer must NEVER load a
 * poisoned aggregate adapter. Per reviewer-lessons P21, the caller does
 * NOT re-queue on this error — the coord ACCEPTED-TTL handles re-routing.
 */
export class AdapterIntegrityError extends Error {
  constructor(
    message: string,
    public readonly reason: 'missing-hash' | 'malformed-hash' | 'sha256-mismatch' | 'download-failed',
  ) {
    super(message);
    this.name = 'AdapterIntegrityError';
  }
}

/** Strip optional `sha256:` prefix and normalize to lowercase hex. */
function normalizeExpectedSha256(expected: string): string {
  const raw = expected.startsWith('sha256:') ? expected.slice('sha256:'.length) : expected;
  return raw.trim().toLowerCase();
}

/** Hex sha256 string check — 64 lowercase hex chars after normalization. */
function isValidSha256Hex(hex: string): boolean {
  return /^[0-9a-f]{64}$/.test(hex);
}

@Injectable()
export class ModelDownloaderHelper {
  getModelCacheDir(homeDir?: string): string {
    return path.join(homeDir ?? os.homedir(), '.synapseia', 'models');
  }

  getAdapterCacheDir(homeDir?: string): string {
    return path.join(homeDir ?? os.homedir(), '.synapseia', 'adapters');
  }

  async ensureBaseModel(
    modelId: string,
    testMode = process.env.NODE_ENV === 'test',
    homeDir?: string,
    execSyncFn: ExecSyncFn = (cmd, opts) => execSync(cmd, opts as Parameters<typeof execSync>[1]),
  ): Promise<string> {
    const safeId = modelId.replace(/\//g, '__');
    const cacheDir = path.join(this.getModelCacheDir(homeDir), safeId);

    if (fs.existsSync(cacheDir)) {
      const files = fs.readdirSync(cacheDir);
      if (files.length > 0) {
        logger.log(`[ModelDownloader] Model "${modelId}" already cached at ${cacheDir}`);
        return cacheDir;
      }
    }

    if (testMode) {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'config.json'), JSON.stringify({ model_type: 'mock', model_id: modelId }));
      logger.log(`[ModelDownloader] Test mode — mock model at ${cacheDir}`);
      return cacheDir;
    }

    logger.log(`[ModelDownloader] Downloading model "${modelId}" to ${cacheDir}...`);
    fs.mkdirSync(cacheDir, { recursive: true });

    try {
      execSyncFn(
        `"${resolvePython()}" -c "from huggingface_hub import snapshot_download; snapshot_download('${modelId}', local_dir='${cacheDir}')"`,
        { stdio: 'inherit' },
      );
      logger.log(`[ModelDownloader] Model "${modelId}" downloaded to ${cacheDir}`);
    } catch (err) {
      try { fs.rmdirSync(cacheDir, { recursive: true } as Parameters<typeof fs.rmdirSync>[1]); } catch { /* */ }
      throw new Error(`Failed to download model "${modelId}": ${(err as Error).message}`);
    }

    return cacheDir;
  }

  /**
   * Download a LoRA adapter and verify its sha256 BEFORE the trainer touches
   * the bytes. F-node-005 (HIGH): without this check a malicious coordinator
   * (or hijacked aggregate path) can ship poisoned weights → torch.load /
   * safetensors RCE candidate under older transformers/peft, plus federated
   * model poisoning across the cohort.
   *
   * Contract:
   *   - `expectedSha256` is REQUIRED. Missing / empty / malformed throws
   *     `AdapterIntegrityError` (fail-closed; never default to "trust").
   *   - Cached adapter is only re-used when `adapter_weights.safetensors`
   *     exists AND its on-disk sha256 matches `expectedSha256`. A drifted
   *     or partial cache forces a fresh download.
   *   - On sha256 mismatch the artefact is deleted from disk before the
   *     throw so a subsequent retry cannot accidentally re-use the
   *     poisoned bytes.
   *   - Output file is `.safetensors`, NOT `.pkl`. Pickle adapters were
   *     the historical RCE vector — Python loader pins `use_safetensors=True`.
   */
  async downloadAdapter(url: string, localPath: string, expectedSha256: string): Promise<void> {
    // P10 + P2: fail-closed if caller didn't pass a hash.
    if (!expectedSha256 || typeof expectedSha256 !== 'string') {
      throw new AdapterIntegrityError(
        `Refusing to download adapter from "${url}": expectedSha256 is required (fail-closed; F-node-005)`,
        'missing-hash',
      );
    }
    const expectedHex = normalizeExpectedSha256(expectedSha256);
    if (!isValidSha256Hex(expectedHex)) {
      throw new AdapterIntegrityError(
        `Refusing to download adapter from "${url}": expectedSha256 is malformed (got "${expectedSha256}")`,
        'malformed-hash',
      );
    }

    fs.mkdirSync(localPath, { recursive: true });
    const weightsPath = path.join(localPath, 'adapter_weights.safetensors');

    // Idempotent cache: only re-use when bytes-on-disk match expected hash.
    // A stale cache from a previous (different-sha) round must NOT short-circuit.
    if (fs.existsSync(weightsPath)) {
      try {
        const cachedBytes = fs.readFileSync(weightsPath);
        const cachedSha = createHash('sha256').update(cachedBytes).digest('hex');
        if (cachedSha === expectedHex) {
          logger.log(`[ModelDownloader] Adapter already cached at ${weightsPath} (sha256 verified)`);
          return;
        }
        logger.warn(
          `[ModelDownloader] Cached adapter at ${weightsPath} sha256 mismatch (cached=${cachedSha}, expected=${expectedHex}); redownloading`,
        );
        try { fs.unlinkSync(weightsPath); } catch { /* */ }
      } catch (err) {
        logger.warn(`[ModelDownloader] Cache check failed for ${weightsPath}: ${(err as Error).message}; redownloading`);
      }
    }

    logger.log(`[ModelDownloader] Downloading adapter from ${url}...`);

    let response: Response;
    try { response = await fetch(url); }
    catch (err) {
      throw new AdapterIntegrityError(
        `Network error downloading adapter from "${url}": ${(err as Error).message}`,
        'download-failed',
      );
    }

    if (!response.ok) {
      throw new AdapterIntegrityError(
        `Failed to download adapter: HTTP ${response.status} from "${url}"`,
        'download-failed',
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const actualHex = createHash('sha256').update(buffer).digest('hex');

    if (actualHex !== expectedHex) {
      // P2 fail-closed. Do NOT keep the poisoned bytes on disk — a retry
      // path that re-reads the cache could otherwise short-circuit past
      // the verify gate if the expected hash is later relaxed.
      logger.warn(
        `[ModelDownloader] sha256 mismatch for adapter from "${url}": expected=${expectedHex}, got=${actualHex} — rejecting`,
      );
      throw new AdapterIntegrityError(
        `Adapter sha256 mismatch from "${url}": expected ${expectedHex}, got ${actualHex}`,
        'sha256-mismatch',
      );
    }

    // Hash matched — only NOW persist to disk.
    fs.writeFileSync(weightsPath, buffer);
    logger.log(
      `[ModelDownloader] Adapter downloaded + verified at ${weightsPath} (${buffer.byteLength} bytes, sha256=${actualHex})`,
    );
  }
}

// Backward-compatible standalone exports
const _dlInstance = new ModelDownloaderHelper();
export const getModelCacheDir = (homeDir?: string) => _dlInstance.getModelCacheDir(homeDir);
export const getAdapterCacheDir = (homeDir?: string) => _dlInstance.getAdapterCacheDir(homeDir);
export const ensureBaseModel = (modelId: string, testMode?: boolean, homeDir?: string, execSyncFn?: ExecSyncFn) =>
  _dlInstance.ensureBaseModel(modelId, testMode, homeDir, execSyncFn);
export const downloadAdapter = (url: string, localPath: string, expectedSha256: string) =>
  _dlInstance.downloadAdapter(url, localPath, expectedSha256);
