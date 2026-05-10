import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom, map } from 'rxjs';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as os from 'os';
import logger from '../../utils/logger';
import type { Identity } from '../identity/identity';
import type { Hardware } from '../hardware/hardware';
import type { P2PNode } from '../p2p/p2p';
import { isPyTorchAvailable, TRAINING_MEM_FLOOR_MB } from '../model/trainer';
import { ModelDiscovery } from '../discovery/model-discovery';
import { resolveTrainingLlmModel } from '../llm/training-llm';
import { IpifyService } from '../shared/infrastructure/ipify.service';
import { buildAuthHeaders } from '../../utils/node-auth';
import { getNodeVersion } from '../../utils/version';

/**
 * Bug G1 (Step 3) — capability set advertised in the most recent heartbeat
 * cycle. Used to detect transitions so the memory-pressure log fires only
 * when the announced list actually changes (no per-cycle spam).
 *
 * Module-private (not on the class) because the helper is provider-scoped
 * and we want one snapshot per process — multiple instantiation paths
 * (CLI vs Nest module) must agree on the same "previous" set.
 */
let lastAnnouncedCapabilities: string[] | null = null;

/**
 * Estimate memory headroom in MB.
 *
 * `os.freemem()` and `process.availableMemory()` both report ~92MB on
 * a 16GB Apple Silicon Mac because vm_stat / Mach kernel does not expose
 * "purgeable cache" as available to the Node runtime. Using either as a
 * pressure signal triggers false-positives constantly on mac-native dev
 * hosts. Linux containers report cgroup-aware values and would work,
 * but the asymmetry produces inconsistent capability advertising
 * across nodes on the same hardware.
 *
 * Instead, treat headroom as `totalmem - rss`: the slack available IF
 * this Node process is the dominant tenant. RSS reflects what THIS
 * process holds; the difference against totalmem is "how much room is
 * left for spawning a training model".
 *
 * Caveats:
 *   - Other processes on the host (IDE, browser) are NOT subtracted.
 *     Acceptable: production node hosts run only this process; dev
 *     hosts are owner-tunable.
 *   - cgroup-limited containers: `os.totalmem()` returns container
 *     limit on Node 18+; RSS is process-scoped. Still works.
 *
 * @param freeMBOverride deterministic test-injection override.
 */
function readAvailableMemMB(freeMBOverride?: number): number {
  if (typeof freeMBOverride === 'number') return freeMBOverride;
  const totalMb = os.totalmem() / (1024 * 1024);
  const rssMb = process.memoryUsage().rss / (1024 * 1024);
  return Math.max(0, Math.floor(totalMb - rssMb));
}

/**
 * Capability tags that demand training-grade RAM headroom and must be
 * stripped from the announced set when free RAM is below
 * `TRAINING_MEM_FLOOR_MB`. Mirrors the four training-class tags
 * `determineCapabilities` may emit: `cpu_training` (PyTorch CPU
 * micro-transformer), `gpu_training` (CUDA / Metal), `lora_training`
 * (LoRA fine-tune), `diloco_training` (DiLoCo distributed). The
 * generic `training` tag is included as a defensive backstop in case
 * any downstream code starts emitting it; today no caller does.
 */
const TRAINING_CAPABILITIES = new Set([
  'training',
  'cpu_training',
  'gpu_training',
  'lora_training',
  'diloco_training',
]);

/**
 * Test-only hook. Resets the module-private "previous" capability snapshot
 * so each unit test starts from a clean slate. Production code never calls
 * this — the snapshot is intentionally process-scoped at runtime.
 */
export function __resetCapabilitySnapshotForTests(): void {
  lastAnnouncedCapabilities = null;
}

export interface HeartbeatPayload {
  peerId: string;
  /** libp2p peerId (base58 CID, 52 chars) — distinct from the Ed25519 peerId.
   *  Persisted in nodes.p2pPeerId so the coordinator can dial over libp2p. */
  p2pPeerId: string;
  publicKey: string;  // Full Ed25519 public key (64 hex chars = 32 bytes)
  walletAddress: string | null;
  /**
   * Hardware class (0-5). NOT the staking tier — the coord ignores this
   * value for WO acceptance gating and instead reads `nodes.tier`
   * (Postgres, on-chain-synced). S13-D: legacy `tier` alias removed
   * from the wire payload — coord only accepts the canonical key now.
   */
  hardwareClass: number;
  capabilities: string[];
  uptime: number;
  name?: string;
  lat?: number;
  lng?: number;
  publicIp?: string; // Self-reported public IP for geo-lookup
  /** GB of GPU VRAM detected locally (0 means CPU-only). */
  vram?: number;
  /** Human-readable GPU model string (e.g. "Apple M1 Pro", "RTX 4090"). */
  gpuModel?: string;
  /** Binary attestation: sha256(chunk + nonce) response to the previous heartbeat's challenge. */
  attestationResponse?: string;
  /** Node software version (semver). Used for version gating. */
  version?: string;
}

export interface AttestationChallenge {
  nonce: string;
  offset: number;
  length: number;
}

export interface HeartbeatResponse {
  registered: boolean;
  peerId: string;
  /** Binary attestation challenge — respond in the NEXT heartbeat. */
  attestationChallenge?: AttestationChallenge;
}

@Injectable()
export class HeartbeatHelper {
  /** Pending attestation challenge from the last heartbeat response. */
  private pendingChallenge: AttestationChallenge | null = null;
  /** Own bundle content — loaded lazily on first attestation challenge. */
  private ownBundle: Buffer | null = null;
  private p2pNode?: P2PNode;

  /**
   * Consecutive failed heartbeat cycles. Only after N consecutive failures
   * (across the existing 3-retry inner loop) do we escalate from warn → error.
   * Single-cycle blips during coordinator restarts no longer flood telemetry
   * with `severity=error` events that the operator can't act on anyway.
   */
  private consecutiveCycleFailures = 0;
  private static readonly ERROR_ESCALATION_THRESHOLD = 5;

  /** Latest p2pNode reference — set before the initial heartbeat so
   *  _sendHeartbeat can call p2pNode.getPeerId() for the p2pPeerId field. */
  setP2PNode(p2pNode: P2PNode): void {
    this.p2pNode = p2pNode;
  }

  constructor(
    private readonly ipifyService: IpifyService,
    private readonly httpService?: HttpService,
  ) {}
  /**
   * Send heartbeat to coordinator with exponential backoff retry
   */
  /**
   * Send signed heartbeat to coordinator.
   * If keypair is available, signs the request with Ed25519.
   */
  async sendHeartbeat(
    coordinatorUrl: string,
    identity: Identity,
    hardware: Hardware,
    lat?: number,
    lng?: number,
    walletAddress?: string | null,
  ): Promise<HeartbeatResponse> {
    return this._sendHeartbeat(coordinatorUrl, identity, hardware, lat, lng, walletAddress);
  }

  /**
   * Internal: supports optional pre-built auth headers for testing.
   */
  private async _sendHeartbeat(
    coordinatorUrl: string,
    identity: Identity,
    hardware: Hardware,
    lat?: number,
    lng?: number,
    walletAddress?: string | null,
  ): Promise<HeartbeatResponse> {
    const startTime = Date.now();
    const rawCapabilities = await this.determineCapabilitiesAsync(hardware);
    // Bug G1: strip training-class capabilities for THIS cycle when free RAM
    // sits below the trainer's pre-flight floor. Coordinator stops routing
    // training WOs to a node that the trainer would reject anyway. Capability
    // returns automatically next cycle once memory recovers.
    const capabilities = this.applyMemoryPressureFilter(rawCapabilities);

    // Resolve public IP for geo-lookup (cached 30 min)
    const publicIp = await this.ipifyService.resolvePublicIp();

    // Attestation: respond to the pending challenge from the PREVIOUS heartbeat.
    let attestationResponse: string | undefined;
    if (this.pendingChallenge) {
      try {
        const bundle = this.loadOwnBundle();
        if (bundle) {
          const { nonce, offset, length } = this.pendingChallenge;
          const chunk = bundle.subarray(offset, offset + length);
          attestationResponse = createHash('sha256')
            .update(Buffer.concat([chunk, Buffer.from(nonce)]))
            .digest('hex');
        }
      } catch (err) {
        logger.debug(`[Heartbeat] Attestation response failed: ${(err as Error).message}`);
      }
      this.pendingChallenge = null;
    }

    const payload: HeartbeatPayload = {
      peerId: identity.peerId,
      p2pPeerId: this.p2pNode?.getPeerId() ?? identity.peerId,
      name: identity.name,
      publicKey: identity.publicKey,  // Full Ed25519 public key for node signature verification
      walletAddress: walletAddress ?? null, // Solana wallet address for reward payouts
      hardwareClass: hardware.hardwareClass,
      capabilities,
      uptime: Math.floor(process.uptime()), // Seconds since process start
      lat,
      lng,
      publicIp: publicIp ?? undefined,
      // Hardware telemetry — lets the coordinator persist real GPU state in
      // the `nodes` table (was always null because the payload lacked these).
      vram: hardware.gpuVramGb || undefined,
      gpuModel: hardware.gpuModel,
      attestationResponse,
      version: getNodeVersion(),
    };

    let lastError: Error | null = null;

    // Build auth headers if keypair is available
    let authHeaders: Record<string, string> = {};
    if (identity.privateKey && identity.publicKey) {
      try {
        authHeaders = await buildAuthHeaders({
          method: 'POST',
          path: '/peer/heartbeat',
          body: payload,
          privateKey: Buffer.from(identity.privateKey, 'hex'),
          publicKey: Buffer.from(identity.publicKey, 'hex'),
          peerId: identity.peerId,
        });
      } catch (signErr) {
        logger.warn('[Heartbeat] Failed to sign heartbeat:', (signErr as Error).message);
      }
    }

    // Exponential backoff: 1s, 2s, 4s
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let response: HeartbeatResponse;
        if (this.httpService) {
          response = await lastValueFrom(
            this.httpService.post<HeartbeatResponse>('/peer/heartbeat', payload, {
              baseURL: coordinatorUrl,
              // 15s (was 5s). Under heavy local inference the Node event
              // loop gets starved and the coordinator can block briefly on
              // embedding/ontology work — 5s was too tight and produced
              // spurious disconnect warnings on healthy nodes.
              timeout: 15000,
              headers: { 'Content-Type': 'application/json', ...authHeaders },
            }).pipe(map(res => res.data)),
          );
        } else {
          // Fallback: use raw axios for standalone CLI usage
          const { default: axios } = await import('axios');
          const client = axios.create({ baseURL: coordinatorUrl, timeout: 15000, headers: { 'Content-Type': 'application/json', ...authHeaders } });
          const axiosRes = await client.post<HeartbeatResponse>('/peer/heartbeat', payload);
          response = axiosRes.data;
        }
        // Store attestation challenge for the NEXT heartbeat
        if (response.attestationChallenge) {
          this.pendingChallenge = response.attestationChallenge;
        }
        return response;
      } catch (error) {
        lastError = error as Error;

        const status = (error as any)?.response?.status ?? (error as any)?.status;
        const body = (error as any)?.response?.data;

        // 403 BETA_LIMIT_REACHED: coord rejected new node registration because
        // its MAX_NODOS cap is full. Coord guarantees structured body:
        //   { statusCode: 403, error: 'Forbidden', code: 'BETA_LIMIT_REACHED',
        //     message: '...', limit: number, current: number }
        // We parse by `code` (stable contract); status 403 alone is overloaded
        // (deny-list also returns 403). Hard exit 0 — expected state, not crash.
        // The user can re-run after MAX_NODOS gets bumped or mainnet launch.
        //
        // Use console.error directly (not logger) so the `[BETA_LIMIT_REACHED]`
        // marker line is emitted verbatim on stderr. The project logger wraps
        // every line with timestamp + ANSI colors + ERROR level prefix, which
        // would break node-ui's regex `/^\[BETA_LIMIT_REACHED\]/m` consumed
        // from the spawned-process stderr stream as a fallback to its
        // pre-flight /peer/capacity probe (S3).
        if (status === 403 && body?.code === 'BETA_LIMIT_REACHED') {
          console.error('');
          console.error('══════════════════════════════════════════════════════');
          console.error('[BETA_LIMIT_REACHED]');
          console.error(
            body.message ??
              'Beta tester limit reached. Synapseia will be available on mainnet soon.',
          );
          if (typeof body.current === 'number' && typeof body.limit === 'number') {
            console.error(`Current: ${body.current}/${body.limit} nodes registered.`);
          }
          console.error('══════════════════════════════════════════════════════');
          console.error('');
          process.exit(0);
        }

        // 426 Upgrade Required: node version is too old. Don't retry.
        if (status === 426) {
          const minVer = body?.minVersion ?? 'unknown';
          logger.error(
            `[Heartbeat] Coordinator rejected version ${getNodeVersion()} ` +
              `(minimum: ${minVer}). Update your node: npm i -g @synapseia-network/node`,
          );
          throw error;
        }

        // Per-attempt failures inside the retry loop are noisy and rarely
        // actionable on their own; the cycle-level summary at line ~401
        // and the final failure at line ~444 still surface as warn/error.
        logger.debug(`Heartbeat attempt ${attempt + 1} failed: ${(error as Error).message}`);

        if (attempt < 2) {
          // Wait before retry: 1s, 2s
          const delayMs = 1000 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    throw new Error(`Failed to send heartbeat after 3 attempts: ${lastError?.message}`);
  }

  /**
   * Determine capabilities based on hardware.
   *
   * Capability taxonomy:
   *  - cpu_training  → hyperparam search (train_micro.py / PyTorch CPU). Any node.
   *  - gpu_training  → DiLoCo federated fine-tuning (LoRA, requires VRAM). GPU nodes only.
   *  - cpu_inference → tokenize / embed / classify. Always enabled (no LLM needed).
   *  - gpu_inference → GPU-accelerated LLM inference (requires VRAM + Ollama or cloud LLM).
   *  - inference     → full LLM inference (requires Ollama or cloud LLM).
   *  - llm           → alias for inference, kept for backwards compat.
   *  - embedding     → Ollama embedding models (requires Ollama + ≥8 GB RAM).
   */

  /** Lazy-load own dist bundle for binary attestation. Cached after first read. */
  private loadOwnBundle(): Buffer | null {
    if (this.ownBundle) return this.ownBundle;
    try {
      // tsup bundles into dist/bootstrap.js → dist/index.js. We attest index.js.
      // Resolve our own file URL via a runtime helper that uses `import.meta`
      // under ESM but gracefully degrades to `process.cwd()` under CJS test
      // runtimes (ts-jest in some configs compiles to CJS, where a literal
      // `import.meta` reference is a TS1343 compile error). Wrapping the
      // access in `new Function(...)` defers evaluation past the type checker.
      const importMetaUrl = this.resolveImportMetaUrl();
      const distDir = importMetaUrl
        ? join(dirname(fileURLToPath(importMetaUrl)), '..')
        : join(process.cwd(), 'dist');
      const candidates = [
        join(distDir, 'index.js'),
        join(process.cwd(), 'dist', 'index.js'),
      ];
      for (const p of candidates) {
        try {
          this.ownBundle = readFileSync(p);
          logger.debug(`[Attestation] Loaded own bundle from ${p} (${(this.ownBundle.length / 1024).toFixed(1)} KB)`);
          return this.ownBundle;
        } catch { /* try next */ }
      }
      logger.debug('[Attestation] Could not locate own dist/index.js — attestation responses will be skipped');
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Returns `import.meta.url` when available (ESM runtime) or null when
   * running under a CJS test environment. Wrapping the access in `new
   * Function(...)` defers parsing past TypeScript's TS1343 check and lets
   * the same source file compile under both ESM (production) and CJS
   * (ts-jest default mode) without a separate transform.
   */
  private resolveImportMetaUrl(): string | null {
    try {
      const probe = new Function(
        'try { return typeof import !== "undefined" && import.meta && import.meta.url || null; } catch { return null; }',
      );
      const url = probe();
      return typeof url === 'string' ? url : null;
    } catch {
      return null;
    }
  }

  /**
   * Bug G1: cycle-local capability gating on memory pressure.
   *
   * Headroom signal = `os.totalmem() - process.memoryUsage().rss`. When
   * total RAM minus our own resident-set is below `TRAINING_MEM_FLOOR_MB`
   * (i.e. spawning a training model would push the host into swap/OOM
   * territory), drop every training-class capability from the announced
   * set so the coordinator stops handing this node training work it
   * would refuse at runtime.
   *
   * Why not `os.freemem()` / `process.availableMemory()`: both return
   * ~92MB on a 16GB Apple Silicon Mac (vm_stat / Mach kernel hides
   * reclaimable cache from the Node runtime). They produce constant
   * false-positives on mac-native dev hosts. See `readAvailableMemMB`.
   *
   * The filter is per-cycle — no state is persisted, so capability
   * automatically returns once memory recovers. The `info` log fires only
   * when the announced list differs from the previous cycle, preventing
   * per-heartbeat spam during sustained pressure.
   *
   * @internal Exposed for unit testing. The optional `freeMBOverride`
   * lets tests inject a deterministic memory reading without having to
   * spy on the `os` / `process` modules — `jest.spyOn` fails under
   * ESM-mode jest because the imported namespaces are frozen.
   */
  applyMemoryPressureFilter(capabilities: string[], freeMBOverride?: number): string[] {
    const freeMB = freeMBOverride ?? readAvailableMemMB();
    const underPressure = freeMB < TRAINING_MEM_FLOOR_MB;
    const filtered = underPressure
      ? capabilities.filter(cap => !TRAINING_CAPABILITIES.has(cap))
      : capabilities;
    const previous = lastAnnouncedCapabilities;
    const sameAsPrevious = !!previous
      && previous.length === filtered.length
      && previous.every((cap, idx) => cap === filtered[idx]);
    if (!sameAsPrevious && previous) {
      const previousHadTraining = previous.some(cap => TRAINING_CAPABILITIES.has(cap));
      const filteredHasTraining = filtered.some(cap => TRAINING_CAPABILITIES.has(cap));
      if (underPressure && !filteredHasTraining && (previousHadTraining || filtered.length < capabilities.length)) {
        logger.info(
          `[Heartbeat] training capability suppressed this cycle (free=${freeMB}MB < floor=${TRAINING_MEM_FLOOR_MB}MB)`,
        );
      } else if (!underPressure && !previousHadTraining && filteredHasTraining) {
        logger.info(
          `[Heartbeat] training capability restored this cycle (free=${freeMB}MB >= floor=${TRAINING_MEM_FLOOR_MB}MB)`,
        );
      }
    }
    lastAnnouncedCapabilities = filtered;
    return filtered;
  }

  determineCapabilities(hardware: Hardware): string[] {
    const capabilities: string[] = [];

    // cpu_training: micro-transformer hyperparam search (PyTorch CPU, requires python3 + torch)
    // NOTE: determineCapabilities() is sync but isPyTorchAvailable() is async.
    // The heartbeat loop calls determineCapabilitiesAsync() instead for accuracy.
    // This sync version assumes PyTorch IS available (conservative default).
    capabilities.push('cpu_training');

    // cpu_inference: tokenize/classify/embedding tasks that run on CPU without a full LLM.
    // Always enabled — these tasks have no GPU/Ollama dependency.
    capabilities.push('cpu_inference');

    // Add LLM-based inference capabilities if Ollama is running OR cloud LLM is configured
    if (hardware.hasOllama || hardware.hasCloudLlm) {
      capabilities.push('inference');
      capabilities.push('llm');
    }

    // Add embedding capability if Ollama can run embeddings
    if (hardware.hasOllama && hardware.ramGb >= 8) {
      capabilities.push('embedding');
    }

    // gpu_training: DiLoCo LoRA fine-tuning — requires dedicated GPU VRAM
    if (hardware.gpuVramGb > 0) {
      capabilities.push('gpu_training');
    }

    // gpu_inference: GPU-accelerated LLM inference. Mirrors hardware.ts:404
    // but kept local so the wire-payload caps array (consumed by coord
    // bid-responder) matches what this hot-path advertises. Sister method
    // `HardwareHelper.getCapabilities` is unused on the heartbeat path —
    // without this push, GPU nodes never expose `gpu_inference` and the
    // coord cannot route GPU_INFERENCE work orders to them. Same gate as
    // `gpu_training` (vram > 0) plus an LLM endpoint to serve from.
    if (hardware.gpuVramGb > 0 && (hardware.hasOllama || hardware.hasCloudLlm)) {
      capabilities.push('gpu_inference');
    }

    return capabilities;
  }

  /**
   * Async version of determineCapabilities — checks PyTorch availability
   * before emitting cpu_training. Used by the heartbeat loop.
   */
  async determineCapabilitiesAsync(hardware: Hardware): Promise<string[]> {
    const caps = this.determineCapabilities(hardware);
    // Verify PyTorch is actually available before claiming cpu_training
    const hasTorch = await isPyTorchAvailable();
    if (!hasTorch) {
      const idx = caps.indexOf('cpu_training');
      if (idx !== -1) caps.splice(idx, 1);
      logger.warn('[Heartbeat] PyTorch not found — removing cpu_training capability. Install with: pip3 install torch');
    }
    // Training WOs need an LLM for the mutation engine. The resolver prefers
    // ≥1.5B local > cloud > sub-1.5B local, and returns null only when NO
    // LLM is reachable. Drop cpu_training only in that terminal case — a
    // small local model sometimes succeeds and the mutation engine aborts
    // cleanly when it doesn't.
    if (caps.includes('cpu_training')) {
      try {
        const trainingModel = await resolveTrainingLlmModel();
        if (!trainingModel) {
          const idx = caps.indexOf('cpu_training');
          if (idx !== -1) caps.splice(idx, 1);
          logger.warn(
            '[Heartbeat] No training LLM reachable (Ollama offline and LLM_CLOUD_MODEL unset) — removing cpu_training capability.',
          );
        }
        // No log on success — fired every 60s heartbeat per tick was log
        // spam. The warn above still fires (and strips cpu_training) when
        // resolution actually fails, which is the only state change worth
        // surfacing.
      } catch (err) {
        logger.warn(`[Heartbeat] Training LLM detection failed: ${(err as Error).message}`);
      }
    }
    return caps;
  }

  /**
   * Start periodic heartbeat. Default 60 s (Tier 3 §3.C.2 — halves the
   * coordinator HTTP heartbeat qps; 5-min online cutoff in
   * `peer.service.ts` still tolerates 5 missed cycles before marking a
   * peer offline).
   * If p2pNode is provided, heartbeat is published via GossipSub.
   * Falls back to HTTP if P2P is not available.
   */
  startPeriodicHeartbeat(
    coordinatorUrl: string,
    identity: Identity,
    hardware: Hardware,
    intervalMs: number = 60000,
    p2pNode?: P2PNode,
    lat?: number,
    lng?: number,
    walletAddress?: string | null,
    ollamaUrl?: string,
  ): () => void {
    this.p2pNode = p2pNode;
    const intervalStartTime = Date.now();
    const modelDiscovery = new ModelDiscovery();

    // S1.8: replace `setInterval(async)` with a self-scheduling loop
    // (audit P0 #7). The original `setInterval(async () => …)` would
    // fire a fresh tick at every `intervalMs` even if the previous
    // tick was still in flight. Two ticks racing through this body
    // mutated `consecutiveCycleFailures` non-atomically and could
    // double-publish heartbeats. The replacement awaits the previous
    // tick fully (success or error) before scheduling the next, so
    // we get exactly one heartbeat per `intervalMs` of wall time
    // even when the coordinator is slow / unreachable.
    let cancelled = false;
    let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      // S10-C C-1: track per-channel outcome so the end-of-tick log
      // can be honest. Pre-fix this branch swallowed HTTP failures
      // in the inner try/catch, then logged "Heartbeat sent via
      // both channels" unconditionally after the P2P publish —
      // operators reading the log thought heartbeats were fine
      // when in reality coord wasn't receiving any (live
      // observation 2026-05-04: 0 hits to /peer/heartbeat in 30 min
      // while the node logged "sent via both channels" every minute).
      let httpStatus: 'ok' | 'fail' | 'skipped' = 'skipped';
      let httpDetail: string | undefined;
      let p2pStatus: 'ok' | 'fail' | 'skipped' = 'skipped';
      let p2pDetail: string | undefined;
      try {
        const uptimeSeconds = Math.floor((Date.now() - intervalStartTime) / 1000);
        // Always send HTTP heartbeat to register with coordinator
        try {
          await this.sendHeartbeat(coordinatorUrl, identity, hardware, lat, lng, walletAddress);
          httpStatus = 'ok';
          if (this.consecutiveCycleFailures > 0) {
            logger.info(`[Heartbeat] recovered after ${this.consecutiveCycleFailures} failed cycle(s)`);
            this.consecutiveCycleFailures = 0;
          }
        } catch (httpErr) {
          httpStatus = 'fail';
          httpDetail = (httpErr as Error).message;
          this.consecutiveCycleFailures++;
          if (this.consecutiveCycleFailures < HeartbeatHelper.ERROR_ESCALATION_THRESHOLD) {
            logger.warn(`[Heartbeat] cycle ${this.consecutiveCycleFailures} failed: ${httpDetail}`);
          } else if (this.consecutiveCycleFailures === HeartbeatHelper.ERROR_ESCALATION_THRESHOLD) {
            logger.error(`[Heartbeat] coordinator unreachable after ${this.consecutiveCycleFailures} consecutive cycles: ${httpDetail}`);
          } else {
            logger.warn(`[Heartbeat] still unreachable (cycle ${this.consecutiveCycleFailures}): ${httpDetail}`);
          }
        }
        // Sprint D: Discovery feedback — register available models with coordinator
        try {
          await modelDiscovery.registerModels(coordinatorUrl, identity.peerId, hardware, identity, ollamaUrl);
        } catch (discErr) {
          logger.warn('Model discovery registration failed:', (discErr as Error).message);
        }
        // Also publish via P2P if available
        if (p2pNode && p2pNode.isRunning()) {
          try {
            const capabilities = await this.determineCapabilitiesAsync(hardware);
            // Do NOT include `publicKey` in the payload we pass in —
            // `p2pNode.publishHeartbeat` canonicalises + signs the
            // payload THEN tacks `publicKey` on post-signing. Leaving
            // publicKey out of the signed payload keeps the two
            // canonicals (node + coord) aligned.
            await p2pNode.publishHeartbeat({
              peerId: p2pNode.getPeerId(),
              p2pPeerId: identity.peerId,
              name: identity.name,
              walletAddress: walletAddress ?? null,
              hardwareClass: hardware.hardwareClass,
              capabilities,
              uptime: uptimeSeconds,
              timestamp: Math.floor(Date.now() / 1000),
            });
            p2pStatus = 'ok';
          } catch (p2pErr) {
            p2pStatus = 'fail';
            p2pDetail = (p2pErr as Error).message;
            // Pre-S10 the P2P branch had no try/catch so a publish
            // failure bubbled up to the outer "Heartbeat failed"
            // catch and aborted the tick. Now we surface it
            // explicitly without breaking the cycle.
            logger.warn(`[Heartbeat] p2p publish failed: ${p2pDetail}`);
          }
        }
        // Single honest end-of-tick line. Old `[P2P+HTTP] Heartbeat
        // sent via both channels` lied when HTTP had silently
        // failed; the reader now sees exactly which channels
        // succeeded.
        const httpStr = httpStatus === 'fail' ? `FAIL:${httpDetail}` : httpStatus;
        const p2pStr = p2pStatus === 'fail' ? `FAIL:${p2pDetail}` : p2pStatus;
        if (httpStatus === 'ok' || p2pStatus === 'ok') {
          logger.info(`[Heartbeat] tick (http=${httpStr}, p2p=${p2pStr})`);
        } else {
          // Both channels failed — already warned per-channel above,
          // so this is a low-priority debug summary.
          logger.debug(`[Heartbeat] tick (http=${httpStr}, p2p=${p2pStr})`);
        }
      } catch (error) {
        logger.error('Heartbeat failed:', (error as Error).message);
      } finally {
        if (!cancelled) {
          pendingTimeout = setTimeout(tick, intervalMs);
        }
      }
    };

    // Kick off the first tick on the next event-loop turn so callers
    // can subscribe to logs / cleanup the returned canceller before
    // anything fires.
    pendingTimeout = setTimeout(tick, 0);

    return () => {
      cancelled = true;
      if (pendingTimeout) clearTimeout(pendingTimeout);
    };
  }
}


