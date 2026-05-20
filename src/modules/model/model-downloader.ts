/**
 * Model Downloader — handles downloading and caching of foundation models and LoRA adapters
 */

import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { execSync, spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'child_process';
import logger from '../../utils/logger';
import { resolvePython } from '../../utils/python-venv';

export type ExecSyncFn = (cmd: string, options?: Record<string, unknown>) => void;

/**
 * F-node-010 (MED): shell-injection seam for `ensureBaseModel`. Replaces the
 * legacy `execSync(string)` invocation that interpolated `modelId` and
 * `cacheDir` directly into a shell command. The new path is `spawnSync` with
 * an argv array — even if the coordinator pushes a hostile `modelId`, no
 * shell parses the value. We still validate `modelId` via a strict regex
 * for defense-in-depth (rejects shell metas before they ever reach python).
 *
 * `SpawnSyncFn` is the injection seam used by tests; production wires it to
 * `spawnSync` from `child_process`.
 */
export type SpawnSyncFn = (
  cmd: string,
  args: ReadonlyArray<string>,
  options: SpawnSyncOptionsWithStringEncoding & { input?: string },
) => SpawnSyncReturns<string>;

/**
 * Hugging Face repo id allowlist. Conservative regex matching the
 * `<org-or-user>/<repo>` form (with optional dots/dashes/underscores).
 * Rejects shell metacharacters ($, `, ;, &, |, \n, etc.) and any
 * non-printable. We accept a single `/` per the HF convention; legacy
 * bare-name models (no `/`) also match.
 */
const MODEL_ID_ALLOWLIST = /^[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)?$/;

/**
 * Python helper script for `snapshot_download`. Reads a single JSON line
 * from stdin ({modelId, cacheDir}) so values never go through the shell
 * nor through `-c` string interpolation. `json.loads` is the boundary
 * that turns the bytes back into Python strings — at that point shell
 * meta characters are just literal characters in a `str`.
 */
const SNAPSHOT_DOWNLOAD_SCRIPT = `
import json, sys
from huggingface_hub import snapshot_download
payload = json.loads(sys.stdin.read())
snapshot_download(payload["modelId"], local_dir=payload["cacheDir"])
`;

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
    // Legacy injection seam — kept for callers that still wire `execSync`
    // in (e.g. older specs). It is intentionally unused on the new
    // spawn-based path (F-node-010) and only preserves positional
    // compatibility for existing call sites.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _execSyncFn: ExecSyncFn = (cmd, opts) => execSync(cmd, opts as Parameters<typeof execSync>[1]),
    spawnSyncFn: SpawnSyncFn = (cmd, args, opts) => spawnSync(cmd, args as string[], opts),
  ): Promise<string> {
    // F-node-010 (MED): hard-validate `modelId` BEFORE it touches anything
    // downstream. `modelId` flows in from coord payload — must be treated
    // as untrusted (P2 fail-closed + P26 prompt-injection-class defense:
    // even though the value never reaches a shell now, validation makes
    // the contract explicit so future refactors don't accidentally
    // reintroduce a shell path).
    if (typeof modelId !== 'string' || modelId.length === 0 || modelId.length > 256) {
      throw new Error('Invalid model id: must be a non-empty string ≤256 chars');
    }
    if (!MODEL_ID_ALLOWLIST.test(modelId)) {
      throw new Error(
        `Invalid model id "${modelId}": only [A-Za-z0-9_.-] and a single "/" are allowed`,
      );
    }

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
      // F-node-010: argv-shaped spawn + stdin-fed JSON payload. The
      // python script reads its inputs from stdin via json.loads —
      // shell metacharacters in modelId / cacheDir are now just bytes
      // inside a Python string literal, NOT shell tokens. There is no
      // path through which they can be interpreted by /bin/sh.
      const proc = spawnSyncFn(
        resolvePython(),
        ['-c', SNAPSHOT_DOWNLOAD_SCRIPT],
        {
          input: JSON.stringify({ modelId, cacheDir }),
          stdio: ['pipe', 'inherit', 'inherit'],
          encoding: 'utf-8',
        },
      );
      if (proc.error) {
        throw proc.error;
      }
      if (proc.status !== 0) {
        throw new Error(`python snapshot_download exited with status ${proc.status}`);
      }
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
export const ensureBaseModel = (
  modelId: string,
  testMode?: boolean,
  homeDir?: string,
  execSyncFn?: ExecSyncFn,
  spawnSyncFn?: SpawnSyncFn,
) => _dlInstance.ensureBaseModel(modelId, testMode, homeDir, execSyncFn, spawnSyncFn);
export const downloadAdapter = (url: string, localPath: string, expectedSha256: string) =>
  _dlInstance.downloadAdapter(url, localPath, expectedSha256);
