/**
 * WorkOrderCoordinatorHelper — all HTTP calls to the coordinator API.
 * Handles: fetch/accept/complete work orders, submit results, download datasets,
 * upload insights, hyperparams, and reference/knowledge-graph context.
 *
 * Supports Ed25519 signing for authenticated node requests.
 * Use setIdentity(keypair, publicKey, peerId) to enable signing.
 */

import { Injectable, OnModuleInit, Inject, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildAuthHeaders } from '../../../utils/node-auth';
import logger from '../../../utils/logger';
import type { WorkOrder, TrainingWorkOrderPayload, ResearchPayload } from './work-order.types';
import type { Experiment } from '../../../types';
import { IdentityService } from '../../../modules/identity/services/identity.service';

@Injectable()
export class WorkOrderCoordinatorHelper implements OnModuleInit {
  private _keypair?: Uint8Array;
  private _publicKey?: Uint8Array;
  private _peerId?: string;

  constructor(
    @Optional() private readonly identityService?: IdentityService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.identityService) {
      try {
        const identity = await this.identityService.getOrCreate();
        if (identity?.privateKey && identity?.publicKey) {
          // Keys are stored as hex strings in identity.json — convert to Uint8Array
          this._keypair = Buffer.from(identity.privateKey, 'hex');
          this._publicKey = Buffer.from(identity.publicKey, 'hex');
          this._peerId = identity.peerId;
          // Debug-level: this line fires on every onModuleInit. Operationally
          // uninteresting once the node is running — keep it accessible when
          // LOG_LEVEL=debug but out of the normal boot stream (above the
          // wallet password prompt).
          logger.debug('[WorkOrderCoordinatorHelper] Ed25519 signing enabled for peerId:', this._peerId?.slice(0, 16) + '...');
        }
      } catch (err) {
        logger.warn('[WorkOrderCoordinatorHelper] Failed to load identity for signing:', (err as Error).message);
      }
    }
  }

  /**
   * Configure Ed25519 identity for signed requests.
   * Call this once after the node has loaded its keypair.
   */
  setIdentity(keypair: Uint8Array, publicKey: Uint8Array, peerId: string): void {
    this._keypair = keypair;
    this._publicKey = publicKey;
    this._peerId = peerId;
  }

  get peerId(): string | undefined {
    return this._peerId;
  }

  /**
   * Build signed fetch options if identity is configured.
   * Falls back to unsigned if no identity is set.
   */
  private async signedFetch(
    url: string,
    method: string,
    body: unknown,
  ): Promise<{ url: string; init: RequestInit }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (this._keypair && this._publicKey && this._peerId) {
      const parsedUrl = new URL(url);
      const pathStr = parsedUrl.pathname + parsedUrl.search;
      const auth = await buildAuthHeaders({
        method,
        path: pathStr,
        body,
        privateKey: this._keypair,
        publicKey: this._publicKey,
        peerId: this._peerId,
      });
      Object.assign(headers, auth);
    }

    return {
      url,
      init: {
        method,
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
    };
  }
  // ── Work order lifecycle ──────────────────────────────────────────────────

  async fetchAvailableWorkOrders(coordinatorUrl: string, peerId: string, capabilities: string[]): Promise<WorkOrder[]> {
    try {
      const capabilitiesParam = capabilities.join(',');
      const url = `${coordinatorUrl}/work-orders/available?peerId=${peerId}&capabilities=${capabilitiesParam}`;
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 404) return [];
        throw new Error(`Failed to fetch work orders: ${response.statusText}`);
      }
      return (await response.json() as WorkOrder[]) || [];
    } catch (error) {
      logger.warn(' Failed to fetch work orders:', (error as Error).message);
      return [];
    }
  }

  async acceptWorkOrder(coordinatorUrl: string, workOrderId: string, peerId: string, nodeCapabilities: string[] = []): Promise<boolean> {
    const url = `${coordinatorUrl}/work-orders/${workOrderId}/accept`;
    logger.log(` [Accept] POST ${url}`);
    try {
      const body = { workOrderId, assigneeAddress: peerId, nodeCapabilities };
      const { url: fetchUrl, init } = await this.signedFetch(url, 'POST', body);
      const response = await fetch(fetchUrl, init);
      if (!response.ok) {
        const error = await response.text();
        logger.warn(` [Accept] HTTP ${response.status} for ${workOrderId}: ${error}`);
        return false;
      }
      logger.log(` [Accept] OK ${response.status} for ${workOrderId}`);
      return true;
    } catch (error) {
      const e = error as Error;
      logger.error(` [Accept] EXCEPTION for ${workOrderId}: name=${e.name} msg=${e.message}`);
      return false;
    }
  }

  async completeWorkOrder(
    coordinatorUrl: string,
    workOrderId: string,
    peerId: string,
    result: string,
    success = true,
    completedIds: Set<string>,
    addToCompleted: (id: string) => void,
    addRewards: (lamports: bigint) => void,
    parseSynToLamports: (s: string) => bigint,
  ): Promise<boolean> {
    if (completedIds.has(workOrderId)) {
      logger.log(` Work order ${workOrderId} already submitted in this session — skipping`);
      return true;
    }
    try {
      const body = { workOrderId, assigneeAddress: peerId, result, success };
      const { url: fetchUrl, init } = await this.signedFetch(`${coordinatorUrl}/work-orders/${workOrderId}/complete`, 'POST', body);
      const response = await fetch(fetchUrl, init);
      if (!response.ok) {
        logger.warn(` Failed to complete work order ${workOrderId}:`, await response.text());
        return false;
      }
      const data = await response.json() as WorkOrder;
      addToCompleted(workOrderId);
      if (success && data.rewardAmount) addRewards(parseSynToLamports(data.rewardAmount));
      return true;
    } catch (error) {
      logger.warn(' Failed to complete work order:', (error as Error).message);
      return false;
    }
  }

  // NOTE: submitResearchResult() removed — coordinator's /papers/results endpoint does not exist.
  // Research results are submitted via completeWorkOrder() which registers a Submission
  // in the active ResearchRound and extracts summary/insights/proposal from the result JSON.

  async uploadInsightToNetwork(
    coordinatorUrl: string,
    nodeId: string,
    topic: string,
    hypothesis: string,
    keyInsights: string[],
    metricValue: number,
    roundId?: string,
    submissionId?: string,
  ): Promise<boolean> {
    if (metricValue <= 0.7) {
      logger.log(`[InsightUpload] Skipping upload — metricValue ${metricValue.toFixed(2)} <= 0.7 threshold`);
      return false;
    }
    try {
      const payload = { nodeId, topic, hypothesis, keyInsights, metricValue, ...(roundId ? { roundId } : {}), ...(submissionId ? { submissionId } : {}) };
      const { url: fetchUrl, init } = await this.signedFetch(`${coordinatorUrl.replace(/\/$/, '')}/insights`, 'POST', payload);
      const response = await fetch(fetchUrl, init);
      if (!response.ok) {
        logger.warn(`[InsightUpload] Failed to upload insight: ${response.status} ${await response.text().catch(() => 'unknown error')}`);
        return false;
      }
      logger.log(`[InsightUpload] Successfully uploaded insight (metric: ${metricValue.toFixed(2)}, topic: ${topic})`);
      return true;
    } catch (error) {
      logger.warn(`[InsightUpload] Network error during upload: ${(error as Error).message}`);
      return false;
    }
  }

  async fetchReferenceContext(coordinatorUrl: string, topic: string): Promise<string> {
    try {
      const res = await fetch(`${coordinatorUrl}/corpus/context?topic=${encodeURIComponent(topic)}&limit=5`);
      if (!res.ok) return '';
      const docs = await res.json() as Array<{ id: string; title: string; content: string; score: number; topic: string; tags?: string[] }>;
      if (!Array.isArray(docs) || docs.length === 0) return '';
      return docs.map(d => `### Previous Discovery (score: ${d.score}/10)\n**${d.title}**\n${d.content}`).join('\n\n');
    } catch (error) {
      logger.warn(`[ReferenceCorpus] Failed to fetch context for topic "${topic}": ${(error as Error).message}`);
      return '';
    }
  }

  async fetchKGraphContext(coordinatorUrl: string, topic: string, missionId?: string): Promise<string> {
    try {
      const params = new URLSearchParams({ topic });
      if (missionId) params.set('missionId', missionId);
      const res = await fetch(`${coordinatorUrl}/knowledge-graph/research-context?${params.toString()}`);
      if (!res.ok) return '';
      const data = await res.json() as { context: string };
      return data.context ?? '';
    } catch (error) {
      logger.warn(`[KnowledgeGraph] Failed to fetch context for topic "${topic}": ${(error as Error).message}`);
      return '';
    }
  }

  async fetchHyperparamConfig(coordinatorUrl: string): Promise<{
    config: { id: string; temperature: number; promptTemplate: string; analysisDepth: string; chunkSize?: number };
    strategy: 'exploit' | 'explore';
  } | null> {
    try {
      const res = await fetch(`${coordinatorUrl}/hyperparams/suggest`);
      if (!res.ok) return null;
      return await res.json() as any;
    } catch { return null; }
  }

  async reportHyperparamExperiment(
    coordinatorUrl: string,
    peerId: string,
    config: { id: string; temperature: number; promptTemplate: string; analysisDepth: string; chunkSize?: number },
    qualityScore: number,
    latencyMs: number,
  ): Promise<void> {
    try {
      const body = { peerId, config: { ...config, chunkSize: config.chunkSize ?? 512 }, qualityScore, latencyMs, tokenCost: 0, papersTested: 1 };
      const { url: fetchUrl, init } = await this.signedFetch(`${coordinatorUrl}/hyperparams/experiments`, 'POST', body);
      await fetch(fetchUrl, init);
    } catch { /* non-critical */ }
  }

  // ── Training ──────────────────────────────────────────────────────────────

  async fetchTopExperiments(coordinatorUrl: string): Promise<Experiment[]> {
    try {
      const res = await fetch(`${coordinatorUrl}/hyperparams/leaderboard`);
      if (!res.ok) return [];
      const data = await res.json() as { leaderboard?: Array<{ config?: { id?: string }; avgQualityScore?: number }> };
      return (data.leaderboard ?? []).slice(0, 5).map(entry => ({
        id: entry.config?.id ?? '',
        model: '',
        hyperparams: (entry.config ?? {}) as Experiment['hyperparams'],
        valLoss: entry.avgQualityScore != null ? 1 / (entry.avgQualityScore + 0.001) : 999,
        status: 'completed' as const,
      }));
    } catch { return []; }
  }

  async submitTrainingExperiment(
    coordinatorUrl: string,
    peerId: string,
    config: TrainingWorkOrderPayload['baseConfig'] & { id?: string },
    valLoss: number,
    durationMs: number,
  ): Promise<void> {
    try {
      const body = {
        peerId,
        config: { id: config?.id ?? `train_${Date.now()}`, temperature: 0, promptTemplate: 'training', analysisDepth: 'training', chunkSize: 512, ...config },
        qualityScore: Math.max(0, Math.min(10, 10 * Math.exp(-valLoss))),
        latencyMs: durationMs, tokenCost: 0, papersTested: 1,
      };
      const { url: fetchUrl, init } = await this.signedFetch(`${coordinatorUrl}/hyperparams/experiments`, 'POST', body);
      await fetch(fetchUrl, init);
    } catch { /* non-critical */ }
  }

  async submitTrainingResult(
    coordinatorUrl: string,
    peerId: string,
    payload: TrainingWorkOrderPayload,
    valLossBefore: number,
    valLossAfter: number,
    durationMs: number,
  ): Promise<void> {
    try {
      const body = {
        peerId,
        domain: payload.domain,
        datasetId: payload.datasetId,
        valLossBefore,
        valLossAfter,
        qualityScore: Math.max(0, Math.min(10, 10 * Math.exp(-valLossAfter))),
        durationMs,
        improved: valLossAfter < payload.currentBestLoss,
        timestamp: Date.now(),
      };
      const { url: fetchUrl, init } = await this.signedFetch(`${coordinatorUrl}/micro-training/results`, 'POST', body);
      const response = await fetch(fetchUrl, init);
      if (!response.ok) {
        logger.warn(`[MicroTraining] Failed to submit: ${response.status} ${await response.text()}`);
      } else {
        logger.log(`[MicroTraining] Result submitted successfully`);
      }
    } catch { /* non-critical */ }
  }

  async uploadGradients(coordinatorUrl: string, domain: string, peerId: string, gradientBuffer: Buffer): Promise<boolean> {
    try {
      const formData = new FormData();
      formData.append('peerId', peerId);
      formData.append('gradients', new Blob([gradientBuffer], { type: 'application/octet-stream' }), 'gradients.pt');

      const headers: Record<string, string> = {};
      if (this._keypair && this._publicKey && this._peerId) {
        const path = `/diloco/${domain}/gradients`;
        const auth = await buildAuthHeaders({
          method: 'POST',
          path,
          body: { peerId },
          privateKey: this._keypair,
          publicKey: this._publicKey,
          peerId: this._peerId,
        });
        Object.assign(headers, auth);
      }

      const response = await fetch(`${coordinatorUrl}/diloco/${domain}/gradients`, { method: 'POST', headers, body: formData });
      if (!response.ok) { logger.warn(`[DiLoCo] Failed to upload gradients: ${await response.text()}`); return false; }
      return true;
    } catch (err) {
      logger.warn(`[DiLoCo] Upload error: ${(err as Error).message}`);
      return false;
    }
  }

  // ── Dataset ───────────────────────────────────────────────────────────────

  getDatasetCacheDir(): string {
    return path.join(os.homedir(), '.synapseia', 'datasets');
  }

  async downloadDataset(coordinatorUrl: string, domain: string): Promise<string> {
    const cacheDir = path.join(this.getDatasetCacheDir(), domain);
    const corpusPath = path.join(cacheDir, 'corpus.txt');
    const metaPath = path.join(cacheDir, 'cache-meta.json');

    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    let cachedEtag: string | undefined;
    let cachedLastModified: string | undefined;
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { etag?: string; lastModified?: string };
        cachedEtag = meta.etag;
        cachedLastModified = meta.lastModified;
      } catch { /* ignore */ }
    }

    const url = `${coordinatorUrl}/datasets/${domain}/corpus`;
    const headers: Record<string, string> = {};
    if (cachedEtag) headers['If-None-Match'] = cachedEtag;
    else if (cachedLastModified) headers['If-Modified-Since'] = cachedLastModified;

    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (error) {
      if (fs.existsSync(corpusPath)) { logger.warn(`[Dataset] Network error; using cached version`); return corpusPath; }
      throw new Error(`Failed to download dataset for '${domain}': ${(error as Error).message}`);
    }

    if (response.status === 304) { logger.log(`[Dataset] '${domain}' corpus unchanged (304)`); return corpusPath; }
    if (!response.ok) {
      if (fs.existsSync(corpusPath)) { logger.warn(`[Dataset] Coordinator returned ${response.status}; using cached`); return corpusPath; }
      throw new Error(`Coordinator returned ${response.status} for dataset '${domain}'`);
    }

    const content = await response.text();
    // CPU training: truncate corpus to MAX_TRAINING_CORPUS_CHARS to prevent timeouts.
    // 50K chars is enough for meaningful training on micro-transformers (CPU ~1-2min/epoch).
    const MAX_TRAINING_CORPUS_CHARS = 50_000;
    const truncated = content.length > MAX_TRAINING_CORPUS_CHARS ? content.slice(0, MAX_TRAINING_CORPUS_CHARS) : content;
    fs.writeFileSync(corpusPath, truncated, 'utf-8');
    const newMeta: { etag?: string; lastModified?: string } = {};
    const newEtag = response.headers.get('etag');
    const newLastModified = response.headers.get('last-modified');
    if (newEtag) newMeta.etag = newEtag;
    if (newLastModified) newMeta.lastModified = newLastModified;
    fs.writeFileSync(metaPath, JSON.stringify(newMeta), 'utf-8');
    logger.log(`[Dataset] '${domain}' corpus downloaded → ${corpusPath} (${truncated.length} chars${content.length > MAX_TRAINING_CORPUS_CHARS ? `, truncated from ${content.length}` : ''})`);
    return corpusPath;
  }
}
