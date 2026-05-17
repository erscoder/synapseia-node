import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom, map } from 'rxjs';
import { createHash } from 'crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as os from 'os';
import logger from '../../utils/logger';
import {
  deleteLoraStackMarker,
  readLoraStackMarker,
  resolvePython,
  venvExists,
  venvPython,
  writeLoraStackMarker,
} from '../../utils/python-venv';
import type { Identity } from '../identity/identity';
import type { Hardware } from '../hardware/hardware';
import type { P2PNode } from '../p2p/p2p';
import {
  isPyTorchAvailable,
  TRAINING_MEM_FLOOR_MB,
  GPU_TRAINING_MEM_FLOOR_MB,
  LORA_TRAINING_MEM_FLOOR_MB,
  LORA_GENERATION_MEM_FLOOR_MB,
  DILOCO_TRAINING_MEM_FLOOR_MB,
  CPU_INFERENCE_MEM_FLOOR_MB,
  GPU_INFERENCE_MEM_FLOOR_MB,
  INFERENCE_MEM_FLOOR_MB,
  LLM_MEM_FLOOR_MB,
  EMBEDDING_MEM_FLOOR_MB,
  DOCKING_MEM_FLOOR_MB,
} from '../model/trainer';
import { isVinaAvailable } from '../docking';
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
 * Estimate memory headroom in MB available to a NEW heavy allocation
 * (e.g. spawning a training model). This signal MUST account for memory
 * held by OTHER processes on the host — the previous `totalmem - rss`
 * heuristic ignored them and let nodes happily accept `gpu_training`
 * WOs on hosts whose real free RAM was 300 MB because some other app
 * (browser, IDE, sidecar Ollama) had eaten the rest.
 *
 * Platform strategy:
 *
 *   - Linux: `os.freemem()` is cgroup-aware in Node 18+ and maps to
 *     `/proc/meminfo` `MemAvailable` semantics. Use it directly.
 *   - macOS: `os.freemem()` matches `vm_stat` "Pages free" exactly
 *     (verified 2026-05-11 on Apple Silicon Node 22 — the historical
 *     "returns 92 MB" claim is no longer reproducible, libuv tracks
 *     real free). But it EXCLUDES "Pages inactive" + "Pages purgeable"
 *     + "Pages speculative", all of which the Mach kernel can reclaim
 *     on demand without paging out. Without adding those back, the
 *     filter strips training caps just because macOS aggressively
 *     caches recently-used pages. Shell out to `vm_stat` once per
 *     probe (~5 ms, NOT cached — heartbeat runs every 60s, the cost
 *     is negligible and caching would mask fast pressure shifts).
 *   - Windows / other: fall back to `os.freemem()` alone. No
 *     platform-specific reclaim API readily available.
 *
 * Fail-safe: if `vm_stat` is missing or hangs (1s timeout), we silently
 * fall back to `os.freemem()` alone. This UNDER-reports available
 * memory and may strip training caps unnecessarily — preferred over
 * over-reporting (which causes OOM mid-training).
 *
 * @param freeMBOverride deterministic test-injection override.
 */
function readAvailableMemMB(freeMBOverride?: number): number {
  if (typeof freeMBOverride === 'number') return freeMBOverride;
  const freeBytes = os.freemem();
  let reclaimableBytes = 0;
  if (process.platform === 'darwin') {
    try {
      const out = execSync('vm_stat', { encoding: 'utf-8', timeout: 1000 });
      // `vm_stat` header on macOS: "Mach Virtual Memory Statistics:
      // (page size of N bytes)" — N is 16384 on Apple Silicon, 4096
      // on Intel. Each subsequent line reports a page count.
      const pageMatch = out.match(/page size of (\d+)/);
      const inactiveMatch = out.match(/Pages inactive:\s+(\d+)/);
      const purgeableMatch = out.match(/Pages purgeable:\s+(\d+)/);
      const speculativeMatch = out.match(/Pages speculative:\s+(\d+)/);
      if (pageMatch && inactiveMatch) {
        const pageSize = parseInt(pageMatch[1], 10);
        const inactive = parseInt(inactiveMatch[1], 10) * pageSize;
        const purgeable = purgeableMatch ? parseInt(purgeableMatch[1], 10) * pageSize : 0;
        const speculative = speculativeMatch ? parseInt(speculativeMatch[1], 10) * pageSize : 0;
        reclaimableBytes = inactive + purgeable + speculative;
      }
    } catch {
      // vm_stat missing or hung — conservative fall-through to freemem
      // alone (under-report, not over-report).
    }
  }
  const totalMb = (freeBytes + reclaimableBytes) / (1024 * 1024);
  return Math.max(0, Math.floor(totalMb));
}

/**
 * Per-capability RAM floors (MB). A cap is stripped from the announced
 * set when free RAM is below ITS floor — not a single global threshold.
 * This is what makes a 2 GB-free node correctly keep `cpu_training`
 * (light) while shedding `gpu_training` / `lora_training` /
 * `diloco_training` (heavy).
 *
 * NOTE: the map name "TRAINING_FLOORS_MB" is historical. It now covers
 * EVERY heavy-memory-routing cap, not just training. Two OOM families
 * share the floor mechanism:
 *   - training caps (cpu/gpu/lora/diloco_training) → local PyTorch
 *     spawn that pulls torch + model into the node process.
 *   - Ollama-routed caps (cpu_inference, gpu_inference, inference,
 *     llm, embedding) → forward to a colocated Ollama daemon that
 *     holds the model resident on system RAM. A pressured host
 *     OOM-crashes Ollama silently.
 *
 * `inference`, `llm`, `embedding` are advertised under the
 * `hasOllama || hasCloudLlm` gate (see `determineCapabilities`). When
 * hasOllama=true those caps ride the same daemon as cpu/gpu_inference
 * and share the OOM exposure. The floor is applied unconditionally —
 * gating on hasOllama would require threading that flag through the
 * filter and a sub-1 GB host is not viable for any operator workload
 * regardless of routing.
 *
 * Caps not listed here are never touched by the filter — they must be
 * genuinely memory-insensitive (no local spawn, no resident model). If
 * a new cap is added to `determineCapabilities` that routes through
 * Ollama or spawns a local process, it MUST get an entry here too.
 *
 * Source of truth for floor VALUES lives in `model/trainer.ts`; this
 * map only routes cap names to those exported constants.
 */
const TRAINING_FLOORS_MB: Record<string, number> = {
  training: TRAINING_MEM_FLOOR_MB,
  cpu_training: TRAINING_MEM_FLOOR_MB,
  gpu_training: GPU_TRAINING_MEM_FLOOR_MB,
  lora_training: LORA_TRAINING_MEM_FLOOR_MB,
  lora_generation: LORA_GENERATION_MEM_FLOOR_MB,
  diloco_training: DILOCO_TRAINING_MEM_FLOOR_MB,
  cpu_inference: CPU_INFERENCE_MEM_FLOOR_MB,
  gpu_inference: GPU_INFERENCE_MEM_FLOOR_MB,
  inference: INFERENCE_MEM_FLOOR_MB,
  llm: LLM_MEM_FLOOR_MB,
  embedding: EMBEDDING_MEM_FLOOR_MB,
  // docking: AutoDock Vina runs as a local subprocess (not Ollama-routed).
  // Floor mirrors `cpu_training` / `cpu_inference` — operator nodes that
  // pass those gates have the headroom Vina needs for a 30 Å box at
  // Tier-1 exhaustiveness defaults.
  docking: DOCKING_MEM_FLOOR_MB,
};

/**
 * Test-only hook. Resets the module-private "previous" capability snapshot
 * so each unit test starts from a clean slate. Production code never calls
 * this — the snapshot is intentionally process-scoped at runtime.
 */
export function __resetCapabilitySnapshotForTests(): void {
  lastAnnouncedCapabilities = null;
  loraStackCache = null;
  loraStackLastError = null;
  loraStackForcedFalseForTest = false;
  loraStackMarkerChecked = false;
  cudaCache = null;
  loraStackWarnEmitted = false;
}

/**
 * Test-only seed for the LoRA stack probe. Drives both branches of
 * `determineCapabilitiesAsync` without spawning a real python3
 * (dynamic `await import('node:child_process')` inside the probe
 * bypasses `jest.mock('child_process')`, so module-level injection is
 * the cleanest test surface). Pass `available=true` to skip the probe
 * entirely; pass `false` plus a `reason` to drive the failure-diagnostic
 * warn path. Production code never calls this.
 */
export function __seedLoraStackProbeForTests(
  available: boolean,
  reason: string | null = null,
): void {
  // Mark hydration done so the seed deterministically wins over any
  // marker that may exist on the host where tests run. Without this
  // a developer with `~/.synapseia/lora-stack-ok` present locally
  // would see the "false seed" branch turn into a true result.
  loraStackMarkerChecked = true;
  if (available) {
    loraStackCache = true;
    loraStackForcedFalseForTest = false;
    loraStackLastError = null;
  } else {
    loraStackCache = null;
    loraStackForcedFalseForTest = true;
    loraStackLastError = reason;
  }
}

/**
 * Cached LoRA stack probe.
 *
 * Bug 12 v2 (root cause) — pre-fix code respawned `python -c "import
 * transformers, peft, datasets, safetensors, accelerate"` on every
 * heartbeat tick whose process cache was cold. Cold transformers import
 * is 4-5s on a busy pod and ANY single 60s timeout poisoned the cap
 * set until the next probe succeeded. Live coord log 2026-05-17 showed
 * POD1 caps oscillating every ~3min between 7 (no lora) and 9 (with
 * lora_training + lora_generation, since lora_generation is gated on
 * lora_training per heartbeat:848).
 *
 * Fix layers (in resolution order each tick):
 *   1. Process-cache: positive result is sticky for the process lifetime.
 *      Once we've ever returned true, return true (avoid the probe even
 *      if the marker is later deleted by an operator mid-run).
 *   2. Marker hydration: on FIRST tick after boot, attempt to read
 *      `~/.synapseia/lora-stack-ok`. If present and its `venvPython`
 *      matches our current `venvPython()`, prime the cache → return
 *      true. NO probe spawn. This is the path POD1 hits every boot
 *      after install-deps writes the marker.
 *   3. Probe fallback: when neither cache nor marker is valid, spawn
 *      the import probe with stderr capture + 60s timeout. On success,
 *      write the marker for future boots. On failure, delete any
 *      stale marker (operator may have `pip uninstall`ed transformers
 *      after the marker was written — keeping the marker would let
 *      the node keep advertising lora_training).
 *
 * Negative results are NOT cached (transient slowness recovers on next
 * tick), and the probe captures stderr into `loraStackLastError` so
 * the heartbeat caller can surface the real failure reason in its
 * one-shot diagnostic warn.
 *
 * Contract: deterministic per-tick result for any node that has run
 * install-deps successfully on this venv. Coord-side capability drift
 * for LoRA caps should be a one-time install/uninstall event, never a
 * per-tick race.
 */
let loraStackCache: boolean | null = null;
let loraStackLastError: string | null = null;
/** Test-only sticky-false override. Production keeps it null so the negative
 *  result is never cached (transient slowness retries on the next heartbeat). */
let loraStackForcedFalseForTest: boolean = false;
/** Have we attempted to hydrate the cache from the on-disk marker yet?
 *  Module-private one-shot: the marker read is cheap (single fs stat +
 *  small JSON parse) but doing it on every tick when the cache is
 *  already populated is wasteful. */
let loraStackMarkerChecked: boolean = false;

/** @internal Exposed for the heartbeat caller's diagnostic warn. */
function getLoraStackLastError(): string | null {
  return loraStackLastError;
}

async function isLoraStackAvailable(): Promise<boolean> {
  if (loraStackCache === true) return true;
  if (loraStackForcedFalseForTest) return false;
  // Marker hydration — one-shot per process. If install-deps wrote a
  // marker for THIS venv, trust it and skip the probe entirely. This
  // is the steady-state path that eliminates the cap oscillation seen
  // in live coord drift logs (POD1 toggling lora_training every ~3min).
  //
  // Bug 12 v2 (reviewer HIGH-1): the marker is only trustworthy when
  // the venv it points to still EXISTS. Pre-fix this branch trusted
  // any marker whose `venvPython` field string-matched `venvPython()`
  // — but if the operator deleted ~/.synapseia/venv after install-deps
  // wrote the marker, the string still matches even though the
  // interpreter is gone. Gating hydration on `venvExists()` makes the
  // marker self-invalidate when the venv disappears; the explicit
  // delete keeps the next boot from re-reading a known-dead marker.
  if (!loraStackMarkerChecked) {
    loraStackMarkerChecked = true;
    const marker = readLoraStackMarker();
    if (marker && venvExists()) {
      loraStackCache = true;
      loraStackLastError = null;
      return true;
    }
    if (marker && !venvExists()) {
      deleteLoraStackMarker();
    }
  }
  // Bug 12 v2 (reviewer HIGH-1): the probe MUST spawn the venv
  // interpreter (where install-deps lands the transformers wheels) —
  // NOT `resolvePython()`, which falls back to system `python3` when
  // the venv is missing. Without the venv there is no transformers
  // import to test (and writing a marker for a non-existent venv
  // would be a lie that the next boot would cheerfully trust). Short-
  // circuit with `false` before paying the spawn cost; the operator
  // can re-run `syn install-deps` to recreate the venv.
  if (!venvExists()) {
    loraStackLastError = 'venv not found at ~/.synapseia/venv (run `syn install-deps`)';
    return false;
  }
  const { spawn } = await import('node:child_process');
  const probeResult = await new Promise<{ ok: boolean; reason: string | null }>((res) => {
    const proc = spawn(
      venvPython(),
      ['-c', 'import transformers, peft, datasets, safetensors, accelerate'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      // Cap captured stderr at 2 KiB so a runaway traceback never
      // bloats the heartbeat log line. The first line of a Python
      // ImportError already names the missing module.
      if (stderr.length < 2048) {
        stderr += chunk.toString('utf-8');
      }
    });
    let settled = false;
    const settle = (ok: boolean, reason: string | null) => {
      if (!settled) {
        settled = true;
        res({ ok, reason });
      }
    };
    proc.on('close', (code) => {
      if (code === 0) {
        settle(true, null);
      } else {
        // First non-empty line of stderr is the most useful — Python
        // tracebacks put the actual ImportError class + message last,
        // but for triage the file/module that failed is sufficient.
        const trimmed = stderr.trim();
        const firstSignal = trimmed
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .pop() ?? `exit code ${code}`;
        settle(false, firstSignal);
      }
    });
    proc.on('error', (err) => settle(false, `spawn failed: ${err.message}`));
    setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      settle(false, 'probe timed out after 60s (cold transformers import on a busy host can hit this — heartbeat will retry next cycle)');
    }, 60_000);
  });
  if (probeResult.ok) {
    loraStackCache = true;
    loraStackLastError = null;
    // Late-bind the marker: if install-deps never ran (e.g. operator
    // bootstrapped the venv manually with their own pip installs),
    // the marker won't exist yet. Writing it here means the NEXT
    // node restart can prime the cache from the marker and skip the
    // 4-5s cold transformers import on first tick.
    //
    // Bug 12 v2 (reviewer HIGH-1): the venv MUST exist for the write
    // to be honest. We early-returned `false` above when
    // !venvExists(), so reaching here implies the venv was present —
    // the guard remains as documentation + belt-and-braces against
    // future refactors that move the early-return.
    if (venvExists()) {
      writeLoraStackMarker({
        venvPython: venvPython(),
      });
    }
  } else {
    loraStackLastError = probeResult.reason;
    // Marker invalidation: if a marker exists but the runtime probe
    // failed, the marker is lying (operator may have `pip
    // uninstall`ed transformers after install-deps wrote the marker).
    // Delete it so the next boot doesn't keep the cache primed under
    // false pretenses. Subsequent ticks fall through to the probe
    // until the operator reinstalls.
    deleteLoraStackMarker();
  }
  return probeResult.ok;
}

/**
 * Cached CUDA probe. Same positive-only cache strategy as the LoRA stack —
 * CUDA availability is a hardware fact stable for the process lifetime.
 */
let cudaCache: boolean | null = null;
async function isCudaAvailable(): Promise<boolean> {
  if (cudaCache === true) return true;
  const { spawn } = await import('node:child_process');
  const result = await new Promise<boolean>((res) => {
    const proc = spawn(
      resolvePython(),
      ['-c', 'import torch; assert torch.cuda.is_available()'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let settled = false;
    const settle = (v: boolean) => { if (!settled) { settled = true; res(v); } };
    proc.on('close', (code) => settle(code === 0));
    proc.on('error', () => settle(false));
    setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } settle(false); }, 30_000);
  });
  if (result) cudaCache = true;
  return result;
}

/**
 * Fire-and-forget warmup of all capability probe caches.
 * Called once at process boot (from cli/index.ts after AppModule init)
 * so the first heartbeat tick at +0s doesn't pay the cold-start cost
 * of 3 sequential python3 spawns + Ollama HTTP.
 *
 * Idempotent: all underlying probes are positive-cache, so a second
 * call after the first has populated the caches is a no-op (returns
 * cached value immediately, no re-spawn).
 */
let warmupStarted = false;

/**
 * Hotfix 0.8.55: throttle the "LoRA Python stack not found" warn to fire
 * AT MOST ONCE per process lifetime. Live operator on M1 16 GB was seeing
 * the warn every 60s heartbeat tick because they qualify (Tier 4,
 * ramGb >= 16) but never installed the stack. Module-private flag mirrors
 * `lastAnnouncedCapabilities` — one snapshot per process, reset only via
 * the test-only `__resetCapabilitySnapshotForTests` hook.
 */
let loraStackWarnEmitted = false;
export function warmCapabilityProbes(): void {
  if (warmupStarted) return;
  warmupStarted = true;
  // All these helpers are idempotent and positive-cache.
  // Errors from any individual probe are already swallowed inside
  // each helper — no top-level catch so any uncaught reject still
  // surfaces in tests.
  void isPyTorchAvailable();
  void isLoraStackAvailable();
  void isCudaAvailable();
  void isVinaAvailable();
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
    // Bug G1: strip training-class capabilities per-cap based on individual
    // RAM floors (see TRAINING_FLOORS_MB). A 2 GB-free node keeps
    // `cpu_training` (floor 900 MB) but sheds `gpu_training` /
    // `lora_training` (floor 4 GB) and `diloco_training` (floor 6 GB), so the
    // coordinator stops routing heavy WOs to a node that would OOM mid-run.
    // Caps return automatically next cycle once memory recovers above their
    // respective floor.
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
   * Bug G1: cycle-local capability gating on memory pressure, per-cap.
   *
   * Headroom signal comes from `readAvailableMemMB()` — on macOS that
   * is `os.freemem() + vm_stat reclaimable pages`, on Linux/Windows
   * `os.freemem()` directly (cgroup-aware in Node 18+). The signal
   * intentionally INCLUDES memory held by other processes — i.e. it
   * answers "could we allocate this much right now without OOM", not
   * "what's this process's share". Each training cap has its OWN
   * floor in `TRAINING_FLOORS_MB` — e.g. `cpu_training` at 900 MB but
   * `gpu_training` at 4 GB and `diloco_training` at 6 GB. A cap is
   * stripped from the announced set iff free RAM is below its
   * individual floor, so a mid-tier host can keep serving cpu_training
   * while shedding the heavier tiers it could no longer fit.
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

    // Per-cap stripping: each training cap is gated by its own floor.
    // Non-training caps (no entry in TRAINING_FLOORS_MB) pass untouched.
    const filtered = capabilities.filter(cap => {
      const floor = TRAINING_FLOORS_MB[cap];
      if (floor === undefined) return true;
      return freeMB >= floor;
    });

    const previous = lastAnnouncedCapabilities;
    if (previous) {
      // Detect per-cap transitions vs the previous cycle. Logs fire only
      // when a specific training cap's state flips (suppressed/restored)
      // — keeps the heartbeat quiet under sustained pressure while still
      // surfacing which cap was dropped or recovered.
      const previousSet = new Set(previous);
      const filteredSet = new Set(filtered);
      for (const cap of Object.keys(TRAINING_FLOORS_MB)) {
        const floor = TRAINING_FLOORS_MB[cap]!;
        const wasAnnounced = previousSet.has(cap);
        const nowAnnounced = filteredSet.has(cap);
        const offeredThisCycle = capabilities.includes(cap);
        if (wasAnnounced && !nowAnnounced && offeredThisCycle) {
          logger.info(
            `[Heartbeat] ${cap} suppressed (free=${freeMB}MB < floor=${floor}MB)`,
          );
        } else if (!wasAnnounced && nowAnnounced) {
          logger.info(
            `[Heartbeat] ${cap} restored (free=${freeMB}MB >= floor=${floor}MB)`,
          );
        }
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

    // lora_training: requires full LoRA Python stack (transformers+peft+datasets)
    // AND enough RAM/VRAM to fit a PubMedBERT-class model. M1 16GB qualifies via MPS;
    // Tier 0 Docker nodes don't. Cache positive result (process-lifetime stable).
    try {
      const hasLoraStack = await isLoraStackAvailable();
      const hasCapacity = hardware.gpuVramGb > 0 || hardware.ramGb >= 16;
      if (hasLoraStack && hasCapacity) {
        caps.push('lora_training');
      } else if (!hasLoraStack && hasCapacity && !loraStackWarnEmitted) {
        // Bug 12: emit the captured probe failure reason so operators can
        // tell apart (a) "transformers not in venv" (re-run install-deps),
        // (b) "import timed out — venv too slow / pod overloaded" (raise
        // timeout or wait for next heartbeat), and (c) "ImportError: cannot
        // import name X from torch" (ABI mismatch — torch wheel ≠ what
        // transformers expects). Previously the warn was gated on
        // `freeMB >= LORA_TRAINING_MEM_FLOOR_MB`, which silently suppressed
        // the diagnostic on pods that ALSO had memory pressure — masking
        // the real failure. Memory-pressure-driven stripping lives in
        // `applyMemoryPressureFilter` (separate concern); the probe failure
        // warn must NOT be gated on it.
        const reason = getLoraStackLastError() ?? 'no error captured';
        logger.warn(
          `[Heartbeat] LoRA Python stack probe failed — not advertising lora_training. ` +
          `Reason: ${reason}. ` +
          `Re-install with: "${resolvePython()}" -m pip install transformers peft datasets safetensors accelerate`,
        );
        loraStackWarnEmitted = true;
      }
    } catch (err) {
      logger.warn(`[Heartbeat] LoRA stack probe failed: ${(err as Error).message}`);
    }

    // lora_generation: CUDA-only subtype (BioGPT-Large 1.5B). M1 MPS does NOT qualify.
    // Only push when CUDA is actually available, not just any GPU. Gated on lora_training
    // being present (otherwise the deps for generation aren't installed either).
    if (caps.includes('lora_training')) {
      try {
        const hasCuda = await isCudaAvailable();
        if (hasCuda) caps.push('lora_generation');
      } catch (err) {
        logger.warn(`[Heartbeat] CUDA probe failed: ${(err as Error).message}`);
      }
    }

    // docking: probe AutoDock Vina + Open Babel. Coordinator's
    // DockingDispatchCron skip-gates opening new MOLECULAR_DOCKING pairs
    // when no online node advertises this cap — so a node with Vina
    // installed MUST advertise it for the dispatcher to run. The probe
    // is non-fatal (returns false on any error) so a missing binary
    // never blocks the heartbeat. Detection is cached positive-only
    // inside `isVinaAvailable` so this is a single PATH-lookup spawn
    // per process lifetime once Vina is found.
    try {
      const hasVina = await isVinaAvailable();
      if (hasVina) caps.push('docking');
    } catch (err) {
      logger.warn(`[Heartbeat] Vina detection failed: ${(err as Error).message}`);
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


