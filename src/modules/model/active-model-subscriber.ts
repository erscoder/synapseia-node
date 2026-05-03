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
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
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

interface ManifestBody {
  modelId?: string;
  sha256?: string;
  bucketUrl?: string;
  [k: string]: unknown;
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
  /**
   * Consecutive `tick()` poll failures. The poll runs every 60s on a flaky
   * coordinator link and a single timeout is not actionable, so the first
   * few are logged at debug. We escalate to warn only once the link looks
   * persistently broken.
   */
  private consecutivePollFailures = 0;
  private static readonly POLL_WARN_THRESHOLD = 3;

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
        // NestJS serializes `null` as an empty body (Content-Length: 0) when
        // there is no active model yet, so `res.json()` would throw
        // "Unexpected end of JSON input" on a perfectly valid "no-active"
        // response. Read as text and parse only when we actually have
        // content.
        const text = await res.text();
        active = text.length > 0
          ? (JSON.parse(text) as ActiveModelResponse)
          : null;
      }
    } catch (err) {
      this.consecutivePollFailures++;
      const msg = (err as Error).message;
      if (this.consecutivePollFailures < ActiveModelSubscriber.POLL_WARN_THRESHOLD) {
        logger.debug(`[ModelSubscriber] poll failed (${this.consecutivePollFailures}): ${msg}`);
      } else if (this.consecutivePollFailures === ActiveModelSubscriber.POLL_WARN_THRESHOLD) {
        logger.warn(`[ModelSubscriber] poll failed for ${this.consecutivePollFailures} consecutive ticks: ${msg}`);
      }
      // After the threshold, stay silent until recovery — re-emitting every
      // tick floods telemetry without adding signal.
      return 'no-active';
    }
    if (this.consecutivePollFailures > 0) {
      logger.info(`[ModelSubscriber] poll recovered after ${this.consecutivePollFailures} failed tick(s)`);
      this.consecutivePollFailures = 0;
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

    // F3-C10 — verify the manifest Ed25519 signature against the
    // coordinator public key. Only runs when
    // COORDINATOR_PUBLIC_KEY_BASE64 is configured; dev environments
    // without it fall back to "sha-only" trust (logged loudly). A
    // mismatch fails closed — we refuse to swap.
    const manifestOk = await this.verifyManifest(active);
    if (!manifestOk) {
      logger.error(
        `[ModelSubscriber] manifest signature verification FAILED for ${active.modelId} — refusing to swap`,
      );
      return 'verify-failed';
    }

    // F3-C8 — do NOT advertise a new version until the swap hook has
    // actually restarted / reloaded the local runtime. Otherwise the
    // node tells auction winners it's serving X while still serving Y,
    // and every bid is a lie.
    if (!this.swapHook) {
      logger.warn(
        `[ModelSubscriber] new active ${active.modelId} downloaded but NO swap hook registered — ` +
          `leaving local serving on ${this.currentModelId ?? 'cloud-only'}. ` +
          `Register via subscriber.setSwapHook(...) to activate this version.`,
      );
      return 'download-failed';
    }
    try {
      await this.swapHook({
        modelId: active.modelId,
        adapterPath,
        sha256: active.sha256,
      });
    } catch (err) {
      logger.error(`[ModelSubscriber] swap hook failed: ${(err as Error).message} — keeping previous version`);
      return 'download-failed';
    }

    // Only after the runtime actually hot-swapped do we flip the
    // advertised version so the next bid reflects reality.
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

  /**
   * F3-C10 — fetch `<bucketUrl dirname>/manifest.json`, verify the
   * `manifestSignature` Ed25519 over the canonical bytes with the
   * coordinator's public key, and sanity-check the inlined `modelId +
   * sha256 + bucketUrl` match what `/models/active` reported. Returns
   * false on ANY mismatch / network failure / parse error — fail
   * closed.
   *
   * When `COORDINATOR_PUBLIC_KEY_BASE64` is not configured:
   *   - `SYNAPSEIA_REQUIRE_SIGNED_MANIFEST=true` ⇒ verification fails
   *     (operator explicitly asked for strict mode but forgot the key).
   *   - unset / false ⇒ skip manifest verification with a loud warn.
   *     Acceptable for devnet but anything facing real traffic should
   *     set the env var.
   */
  private async verifyManifest(active: ActiveModelResponse): Promise<boolean> {
    const pubKeyB64 = process.env.COORDINATOR_PUBLIC_KEY_BASE64;
    const strict =
      (process.env.SYNAPSEIA_REQUIRE_SIGNED_MANIFEST ?? '').toLowerCase() === 'true';

    if (!pubKeyB64) {
      if (strict) return false;
      logger.warn(
        `[ModelSubscriber] COORDINATOR_PUBLIC_KEY_BASE64 not set — manifest signature NOT verified (dev mode). ` +
          `Set SYNAPSEIA_REQUIRE_SIGNED_MANIFEST=true in production to fail-closed.`,
      );
      return true;
    }

    if (!active.manifestSignature || active.manifestSignature === 'dev-unsigned') {
      logger.error(
        `[ModelSubscriber] manifest for ${active.modelId} is dev-unsigned but node is in signed mode — refusing`,
      );
      return false;
    }

    // Manifest URL is `<adapter dir>/manifest.json`.
    const manifestUrl = active.bucketUrl.replace(/\/adapter\.[^/]+$/, '/manifest.json');
    let body: Buffer;
    let parsed: ManifestBody;
    try {
      const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        logger.error(`[ModelSubscriber] manifest fetch ${manifestUrl} HTTP ${res.status}`);
        return false;
      }
      body = Buffer.from(await res.arrayBuffer());
      parsed = JSON.parse(body.toString('utf8')) as ManifestBody;
    } catch (err) {
      logger.error(`[ModelSubscriber] manifest fetch failed: ${(err as Error).message}`);
      return false;
    }

    if (parsed.modelId !== active.modelId) {
      logger.error(
        `[ModelSubscriber] manifest modelId=${parsed.modelId} does not match /models/active modelId=${active.modelId}`,
      );
      return false;
    }
    if (parsed.sha256 !== active.sha256) {
      logger.error(
        `[ModelSubscriber] manifest sha256 does not match /models/active sha256`,
      );
      return false;
    }

    try {
      const pkcs1Der = Buffer.from(pubKeyB64, 'base64');
      const pubKey = createPublicKey({ key: pkcs1Der, format: 'der', type: 'spki' });
      const sig = Buffer.from(active.manifestSignature, 'base64');
      const ok = cryptoVerify(null, body, pubKey, sig);
      return ok;
    } catch (err) {
      logger.error(`[ModelSubscriber] manifest signature verify error: ${(err as Error).message}`);
      return false;
    }
  }
}
