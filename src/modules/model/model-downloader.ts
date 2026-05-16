/**
 * Model Downloader — handles downloading and caching of foundation models and LoRA adapters
 */

import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import logger from '../../utils/logger';
import { resolvePython } from '../../utils/python-venv';

export type ExecSyncFn = (cmd: string, options?: Record<string, unknown>) => void;

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

  async downloadAdapter(url: string, localPath: string): Promise<void> {
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
    try { response = await fetch(url); }
    catch (err) { throw new Error(`Network error downloading adapter from "${url}": ${(err as Error).message}`); }

    if (!response.ok) throw new Error(`Failed to download adapter: HTTP ${response.status} from "${url}"`);

    const buffer = await response.arrayBuffer();
    const weightsPath = path.join(localPath, 'adapter_weights.pkl');
    fs.writeFileSync(weightsPath, Buffer.from(buffer));
    logger.log(`[ModelDownloader] Adapter downloaded to ${weightsPath} (${buffer.byteLength} bytes)`);
  }
}

// Backward-compatible standalone exports
const _dlInstance = new ModelDownloaderHelper();
export const getModelCacheDir = (homeDir?: string) => _dlInstance.getModelCacheDir(homeDir);
export const getAdapterCacheDir = (homeDir?: string) => _dlInstance.getAdapterCacheDir(homeDir);
export const ensureBaseModel = (modelId: string, testMode?: boolean, homeDir?: string, execSyncFn?: ExecSyncFn) =>
  _dlInstance.ensureBaseModel(modelId, testMode, homeDir, execSyncFn);
export const downloadAdapter = (url: string, localPath: string) => _dlInstance.downloadAdapter(url, localPath);
