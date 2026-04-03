/**
 * WorkOrderCoordinatorHelper — all HTTP calls to the coordinator API.
 * Handles: fetch/accept/complete work orders, submit results, download datasets,
 * upload insights, hyperparams, and reference/knowledge-graph context.
 */

import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import logger from '../../../utils/logger';
import type { WorkOrder, ResearchResult, TrainingWorkOrderPayload, ResearchPayload } from './work-order.types';
import type { Experiment } from '../../../types';

@Injectable()
export class WorkOrderCoordinatorHelper {
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
      const body = JSON.stringify({ workOrderId, assigneeAddress: peerId, nodeCapabilities });
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
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
      const response = await fetch(`${coordinatorUrl}/work-orders/${workOrderId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workOrderId, assigneeAddress: peerId, result, success }),
      });
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

  // ── Research ──────────────────────────────────────────────────────────────

  async submitResearchResult(
    coordinatorUrl: string,
    workOrderId: string,
    peerId: string,
    result: ResearchResult,
    hyperparams?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const response = await fetch(`${coordinatorUrl}/research-queue/results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paperId: workOrderId,
          peerId,
          nodeId: peerId,
          summary: result.summary,
          keyInsights: result.keyInsights,
          applicationProposal: result.proposal,
          ...(hyperparams ? { hyperparams } : {}),
        }),
      });
      if (!response.ok) { logger.warn(` Failed to submit research result:`, await response.text()); return false; }
      logger.log(` Research result submitted successfully`);
      return true;
    } catch (error) {
      logger.warn(' Failed to submit research result:', (error as Error).message);
      return false;
    }
  }

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
      const response = await fetch(`${coordinatorUrl.replace(/\/$/, '')}/insights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
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
      await fetch(`${coordinatorUrl}/hyperparams/experiments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId, config: { ...config, chunkSize: config.chunkSize ?? 512 }, qualityScore, latencyMs, tokenCost: 0, papersTested: 1 }),
      });
    } catch { /* non-critical */ }
  }

  // ── Training ──────────────────────────────────────────────────────────────

  async fetchTopExperiments(coordinatorUrl: string): Promise<Experiment[]> {
    try {
      const res = await fetch(`${coordinatorUrl}/hyperparams/leaderboard`);
      if (!res.ok) return [];
      const data = await res.json() as { entries?: Array<{ config?: { id?: string }; bestScore?: number }> };
      return (data.entries ?? []).slice(0, 5).map(entry => ({
        id: entry.config?.id ?? '',
        model: '',
        hyperparams: (entry.config ?? {}) as Experiment['hyperparams'],
        valLoss: entry.bestScore ?? 999,
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
      await fetch(`${coordinatorUrl}/hyperparams/experiments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          peerId,
          config: { id: config?.id ?? `train_${Date.now()}`, temperature: 0, promptTemplate: 'training', analysisDepth: 'training', chunkSize: 512, ...config },
          qualityScore: Math.max(0, Math.min(10, 10 * Math.exp(-valLoss))),
          latencyMs: durationMs, tokenCost: 0, papersTested: 1,
        }),
      });
    } catch { /* non-critical */ }
  }

  async submitTrainingToExperiments(
    coordinatorUrl: string,
    peerId: string,
    payload: TrainingWorkOrderPayload,
    valLoss: number,
    finalLoss: number,
    durationMs: number,
  ): Promise<void> {
    try {
      await fetch(`${coordinatorUrl}/experiments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId, domain: payload.domain, datasetId: payload.datasetId, valLoss, finalLoss, durationMs, improved: valLoss < payload.currentBestLoss, createdAt: Date.now() }),
      });
    } catch { /* non-critical */ }
  }

  async uploadGradients(coordinatorUrl: string, domain: string, peerId: string, gradientBuffer: Buffer): Promise<boolean> {
    try {
      const formData = new FormData();
      formData.append('peerId', peerId);
      formData.append('gradients', new Blob([gradientBuffer], { type: 'application/octet-stream' }), 'gradients.pt');
      const response = await fetch(`${coordinatorUrl}/diloco/${domain}/gradients`, { method: 'POST', body: formData });
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
    fs.writeFileSync(corpusPath, content, 'utf-8');
    const newMeta: { etag?: string; lastModified?: string } = {};
    const newEtag = response.headers.get('etag');
    const newLastModified = response.headers.get('last-modified');
    if (newEtag) newMeta.etag = newEtag;
    if (newLastModified) newMeta.lastModified = newLastModified;
    fs.writeFileSync(metaPath, JSON.stringify(newMeta), 'utf-8');
    logger.log(`[Dataset] '${domain}' corpus downloaded → ${corpusPath} (${content.length} chars)`);
    return corpusPath;
  }
}
