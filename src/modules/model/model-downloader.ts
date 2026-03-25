/**
 * Model Downloader
 *
 * Handles downloading and caching of:
 * - Foundation models (Qwen2.5-7B etc.) from HuggingFace
 * - LoRA adapter weights from the coordinator
 */

import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import logger from '../../utils/logger.js';

/** Base directory for locally cached models */
export function getModelCacheDir(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), '.synapseia', 'models');
}

/** Base directory for locally cached adapters */
export function getAdapterCacheDir(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), '.synapseia', 'adapters');
}

/**
 * Ensure a foundation model is available locally.
 *
 * If the model is already cached at ~/.synapseia/models/{modelId}/,
 * returns the local path immediately.
 *
 * Otherwise downloads from HuggingFace using the huggingface_hub CLI.
 *
 * In test mode (NODE_ENV=test or testMode=true), skips the actual
 * download and returns a mock path.
 *
 * @param modelId - HuggingFace model ID, e.g. "Qwen/Qwen2.5-7B"
 * @param testMode - Skip actual download, return mock path
 * @returns Local path to the model directory
 */
export type ExecSyncFn = (cmd: string, options?: Record<string, unknown>) => void;

export async function ensureBaseModel(
  modelId: string,
  testMode = process.env.NODE_ENV === 'test',
  homeDir?: string,
  execSyncFn: ExecSyncFn = (cmd, opts) => execSync(cmd, opts as Parameters<typeof execSync>[1]),
): Promise<string> {
  // Sanitise modelId for use as directory name
  const safeId = modelId.replace(/\//g, '__');
  const cacheDir = path.join(getModelCacheDir(homeDir), safeId);

  // Already cached?
  if (fs.existsSync(cacheDir)) {
    const files = fs.readdirSync(cacheDir);
    if (files.length > 0) {
      logger.log(`[ModelDownloader] Model "${modelId}" already cached at ${cacheDir}`);
      return cacheDir;
    }
  }

  if (testMode) {
    // In test mode: create a mock directory and return it
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'config.json'),
      JSON.stringify({ model_type: 'mock', model_id: modelId }),
    );
    logger.log(`[ModelDownloader] Test mode — mock model at ${cacheDir}`);
    return cacheDir;
  }

  // Real download via huggingface_hub
  logger.log(
    `[ModelDownloader] Downloading model "${modelId}" to ${cacheDir}...`,
  );
  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    execSyncFn(
      `python3 -c "from huggingface_hub import snapshot_download; snapshot_download('${modelId}', local_dir='${cacheDir}')"`,
      { stdio: 'inherit' },
    );
    logger.log(`[ModelDownloader] Model "${modelId}" downloaded to ${cacheDir}`);
  } catch (err) {
    // Clean up incomplete download
    try {
      fs.rmdirSync(cacheDir, { recursive: true } as Parameters<typeof fs.rmdirSync>[1]);
    } catch {
      // ignore cleanup errors
    }
    throw new Error(
      `Failed to download model "${modelId}": ${(err as Error).message}`,
    );
  }

  return cacheDir;
}

/**
 * Download a LoRA adapter from a URL to a local path.
 *
 * If the localPath already exists and is non-empty, skips the download.
 *
 * @param url - URL to the adapter weights (e.g. coordinator HTTP endpoint)
 * @param localPath - Local directory to save the adapter
 */
export async function downloadAdapter(
  url: string,
  localPath: string,
): Promise<void> {
  // Already exists?
  if (fs.existsSync(localPath)) {
    const files = fs.readdirSync(localPath);
    if (files.length > 0) {
      logger.log(`[ModelDownloader] Adapter already cached at ${localPath}`);
      return;
    }
  }

  fs.mkdirSync(localPath, { recursive: true });

  logger.log(`[ModelDownloader] Downloading adapter from ${url}...`);

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(
      `Network error downloading adapter from "${url}": ${(err as Error).message}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to download adapter: HTTP ${response.status} from "${url}"`,
    );
  }

  const buffer = await response.arrayBuffer();
  const weightsPath = path.join(localPath, 'adapter_weights.pkl');
  fs.writeFileSync(weightsPath, Buffer.from(buffer));

  logger.log(
    `[ModelDownloader] Adapter downloaded to ${weightsPath} (${buffer.byteLength} bytes)`,
  );
}

/**
 * Injectable NestJS wrapper.
 */
@Injectable()
export class ModelDownloaderHelper {
  ensureBaseModel(modelId: string, testMode?: boolean, homeDir?: string, execSyncFn?: ExecSyncFn): Promise<string> {
    return ensureBaseModel(modelId, testMode, homeDir, execSyncFn);
  }

  downloadAdapter(url: string, localPath: string): Promise<void> {
    return downloadAdapter(url, localPath);
  }

  getModelCacheDir(homeDir?: string): string {
    return getModelCacheDir(homeDir);
  }

  getAdapterCacheDir(homeDir?: string): string {
    return getAdapterCacheDir(homeDir);
  }
}

export const _test = {
  ensureBaseModel,
  downloadAdapter,
  getModelCacheDir,
  getAdapterCacheDir,
};
