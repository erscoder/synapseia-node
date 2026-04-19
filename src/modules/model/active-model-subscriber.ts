/**
 * F3-P2 — node-side subscriber for `model.published` updates.
 *
 * Polls the coordinator's `GET /models/active` endpoint every
 * `MODEL_POLL_INTERVAL_MS` (default 60 s). When the active modelId
 * changes, downloads the new adapter, verifies SHA256 against the
 * manifest, swaps it into the local serving runtime and updates
 * `SynapseiaServingClient` so future bids advertise the right version.
 *
 * Poll loop is intentionally simple — a WebSocket push would be
 * quicker, but nodes already poll for work anyway so the steady-state
 * cost is negligible. When a node joins mid-canary it gets the active
 * version within one tick.
 *
 * The runtime hot-swap itself is delegated to a caller-provided hook
 * (`onSwap(version, adapterPath)`) so the operator decides whether to
 * restart llama.cpp, SIGHUP it, or use `vLLM`'s hot-reload API. We
 * don't ship that glue in v1 — we ship the subscription + download
 * pipeline and expose a hook.
 */

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import logger from '../../utils/logger';
import { SynapseiaServingClient } from '../llm/synapseia-serving-client';

interface ActiveModelResponse {
  modelId: string;
  version: number;
  generation: number;
  sha256: string;
  bucketUrl: string;
  manifestSignature: string;
}

export type ModelSwapHook = (params: {
  modelId: string;
  adapterPath: string;
  sha256: string;
}) => Promise<void>;

const DEFAULT_INTERVAL_MS = 60_000;

@Injectable()
export class ActiveModelSubscriber implements OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentModelId: string | null = null;
  private swapHook: ModelSwapHook | null = null;

  constructor(private readonly serving: SynapseiaServingClient) {}

  /**
   * The operator registers a hook that restarts the local llama.cpp /
   * vLLM process with the new adapter. The hook is called AFTER the
   * adapter has been downloaded + SHA-verified; any failure inside the
   * hook leaves the previous version active.
   */
  setSwapHook(hook: ModelSwapHook): void {
    this.swapHook = hook;
  }

  start(): void {
    if (this.timer) return;
    if (process.env.MODEL_SUBSCRIBER_DISABLED === 'true') return;
    const intervalMs =
      parseInt(process.env.MODEL_POLL_INTERVAL_MS ?? '', 10) || DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    logger.info(`[ModelSubscriber] started — interval=${intervalMs}ms`);
    // Prime immediately so a freshly-booted node picks the active
    // version without waiting a full interval.
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<'no-active' | 'unchanged' | 'swapped' | 'download-failed' | 'verify-failed'> {
    const coordUrl = process.env.COORDINATOR_URL ?? 'http://localhost:3701';
    let active: ActiveModelResponse | null = null;
    try {
      const res = await fetch(`${coordUrl}/models/active`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = (await res.json()) as ActiveModelResponse | null;
        active = body;
      }
    } catch (err) {
      logger.warn(`[ModelSubscriber] poll failed: ${(err as Error).message}`);
      return 'no-active';
    }

    if (!active || !active.modelId) return 'no-active';
    if (active.modelId === this.currentModelId) return 'unchanged';

    logger.info(`[ModelSubscriber] new active ${active.modelId} (was ${this.currentModelId ?? 'none'}) — downloading`);
    let adapterPath: string;
    try {
      adapterPath = await this.downloadAdapter(active);
    } catch (err) {
      logger.error(`[ModelSubscriber] download failed: ${(err as Error).message}`);
      return 'download-failed';
    }

    if (!this.verifyAdapter(adapterPath, active.sha256)) {
      logger.error(`[ModelSubscriber] sha256 mismatch for ${active.modelId} — aborting swap`);
      return 'verify-failed';
    }

    if (this.swapHook) {
      try {
        await this.swapHook({
          modelId: active.modelId,
          adapterPath,
          sha256: active.sha256,
        });
      } catch (err) {
        logger.error(`[ModelSubscriber] swap hook failed: ${(err as Error).message}`);
        return 'download-failed';
      }
    }

    this.serving.setActiveVersion(active.modelId);
    this.currentModelId = active.modelId;
    logger.info(`[ModelSubscriber] now serving ${active.modelId}`);
    return 'swapped';
  }

  /**
   * Downloads the adapter at `active.bucketUrl` to the node's adapter
   * cache dir. Idempotent: if the cached file already matches the
   * expected SHA-256, the download is skipped.
   */
  private async downloadAdapter(active: ActiveModelResponse): Promise<string> {
    const cacheDir = process.env.SYNAPSEIA_ADAPTER_CACHE_DIR ??
      path.join(process.env.HOME ?? '/tmp', '.synapseia', 'adapters');
    fs.mkdirSync(cacheDir, { recursive: true });
    const target = path.join(cacheDir, `${active.modelId.replace(/[:/]/g, '_')}.safetensors`);
    if (fs.existsSync(target) && this.verifyAdapter(target, active.sha256)) {
      return target;
    }
    const res = await fetch(active.bucketUrl, { signal: AbortSignal.timeout(5 * 60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(target, bytes);
    return target;
  }

  private verifyAdapter(adapterPath: string, expectedSha256: string): boolean {
    try {
      const bytes = fs.readFileSync(adapterPath);
      const sha = createHash('sha256').update(bytes).digest('hex');
      return sha === expectedSha256;
    } catch {
      return false;
    }
  }
}
