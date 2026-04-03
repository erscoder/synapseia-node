/**
 * WorkOrderEvaluationHelper — scoring, economics, and LLM cost evaluation.
 */

import { Injectable } from '@nestjs/common';
import logger from '../../../utils/logger';
import type {
  WorkOrder,
  ResearchResult,
  EconomicConfig,
  WorkOrderEvaluation,
  ResearchPayload,
} from './work-order.types';

const LLM_PRICE_TABLE: Record<string, number> = {
  'gpt-4o': 0.005,
  'gpt-4o-mini': 0.00015,
  'gpt-4-turbo': 0.01,
  'gpt-3.5-turbo': 0.0005,
  'claude-haiku': 0.00025,
  'claude-haiku-3': 0.00025,
  'claude-sonnet': 0.003,
  'claude-opus': 0.015,
  'gemini-flash': 0.000075,
  'gemini-pro': 0.00035,
  'MiniMax-M2.7': 0.00222,
  'minimax/MiniMax-M2.7': 0.00222,
  'ollama/phi4-mini': 0,
  'ollama/llama3': 0,
  'ollama/mistral': 0,
};
const DEFAULT_MODEL_PRICE = 0.00025;

/** Cached SYN price */
let _synPriceCache: { price: number; fetchedAt: number } | null = null;
const SYN_PRICE_CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class WorkOrderEvaluationHelper {
  getModelCostPer1kTokens(model: string): number {
    if (model in LLM_PRICE_TABLE) return LLM_PRICE_TABLE[model];
    if (model.startsWith('ollama/')) return 0;
    logger.warn(`Unknown model "${model}" — falling back to claude-haiku pricing ($${DEFAULT_MODEL_PRICE}/1K tokens)`);
    return DEFAULT_MODEL_PRICE;
  }

  scoreResearchResult(result: ResearchResult): number {
    let score = 0;
    const summaryLen = (result.summary ?? '').trim().length;
    if (summaryLen >= 80) score += 0.3;
    else if (summaryLen > 20) score += 0.3 * ((summaryLen - 20) / 60);

    const insights = Array.isArray(result.keyInsights) ? result.keyInsights : [];
    const insightCount = insights.length;
    if (insightCount >= 3) score += 0.3;
    else if (insightCount > 0) score += 0.3 * (insightCount / 3);
    if (insightCount > 0) {
      const avgLen = insights.reduce((sum, s) => sum + (s ?? '').trim().length, 0) / insightCount;
      if (avgLen >= 30) score += 0.1;
    }

    const proposalLen = (result.proposal ?? '').trim().length;
    if (proposalLen >= 100) score += 0.3;
    else if (proposalLen > 20) score += 0.3 * ((proposalLen - 20) / 80);

    return Math.round(Math.min(score, 1.0) * 100) / 100;
  }

  loadEconomicConfig(runtimeModel?: string): EconomicConfig {
    const llmModel = runtimeModel ?? process.env.LLM_MODEL ?? 'ollama/phi4-mini';
    const isOllamaModel = llmModel.startsWith('ollama/');
    const llmType: 'ollama' | 'cloud' = isOllamaModel ? 'ollama' : 'cloud';

    let llmCostPer1kTokens: number;
    if (process.env.LLM_COST_PER_1K_TOKENS) {
      llmCostPer1kTokens = parseFloat(process.env.LLM_COST_PER_1K_TOKENS);
    } else if (llmType === 'ollama') {
      llmCostPer1kTokens = 0;
    } else {
      llmCostPer1kTokens = this.getModelCostPer1kTokens(llmModel);
    }

    const synPriceUsd = parseFloat(process.env.SYN_PRICE_USD ?? '0.01');
    return {
      synPriceUsd,
      llmType,
      llmModel,
      llmCostPer1kTokens,
      minProfitRatio: parseFloat(process.env.MIN_PROFIT_RATIO ?? '1.5'),
    };
  }

  async loadEconomicConfigAsync(runtimeModel?: string): Promise<EconomicConfig> {
    const base = this.loadEconomicConfig(runtimeModel);
    if (!process.env.SYN_PRICE_USD) {
      base.synPriceUsd = await this.fetchSynPriceUsd();
    }
    return base;
  }

  async fetchSynPriceUsd(): Promise<number> {
    const DEVNET_PRICE = 0.01;
    if (process.env.NODE_ENV !== 'production') return DEVNET_PRICE;
    if (_synPriceCache && Date.now() - _synPriceCache.fetchedAt < SYN_PRICE_CACHE_TTL_MS) {
      return _synPriceCache.price;
    }
    const tokenAddress = process.env.SYN_TOKEN_ADDRESS;
    if (!tokenAddress) {
      logger.warn('[SynPrice] SYN_TOKEN_ADDRESS not set — using fallback price $0.01');
      return DEVNET_PRICE;
    }
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
      const data = await response.json() as { pairs?: Array<{ priceUsd?: string; liquidity?: { usd?: number } }> };
      const pairs = (data.pairs ?? []).filter(p => p.priceUsd);
      if (pairs.length === 0) throw new Error('No pairs returned');
      pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const price = parseFloat(pairs[0].priceUsd!);
      if (isNaN(price) || price <= 0) throw new Error('Invalid price from DexScreener');
      _synPriceCache = { price, fetchedAt: Date.now() };
      logger.log(`[SynPrice] Fetched SYN price from DexScreener: $${price}`);
      return price;
    } catch (err) {
      logger.warn(`[SynPrice] DexScreener fetch failed: ${(err as Error).message} — using fallback $0.01`);
      return DEVNET_PRICE;
    }
  }

  estimateLLMCost(abstract: string, config: EconomicConfig): number {
    if (config.llmType === 'ollama') return 0;
    const inputTokens = Math.ceil(abstract.length / 4);
    const outputTokens = 500;
    const totalTokens = inputTokens + outputTokens;
    return (totalTokens / 1000) * config.llmCostPer1kTokens;
  }

  evaluateWorkOrder(workOrder: WorkOrder, config: EconomicConfig): WorkOrderEvaluation {
    const parseSynToLamports = (rewardStr: string): bigint => {
      if (!rewardStr) return 0n;
      if (!rewardStr.includes('.')) return BigInt(rewardStr);
      const [intPart, decPart = ''] = rewardStr.split('.');
      const paddedDec = decPart.padEnd(9, '0').slice(0, 9);
      return BigInt(intPart) * 1_000_000_000n + BigInt(paddedDec);
    };

    const bountySyn = parseSynToLamports(workOrder.rewardAmount);
    const bountyUsd = (Number(bountySyn) / 1e9) * config.synPriceUsd;

    if (!this.isResearchWorkOrder(workOrder)) {
      return { shouldAccept: true, bountySyn, bountyUsd, estimatedCostUsd: 0, profitRatio: Infinity, reason: 'Non-research WO: no compute cost estimation needed' };
    }

    const payload = this.extractResearchPayload(workOrder);
    if (!payload) {
      return { shouldAccept: false, bountySyn, bountyUsd, estimatedCostUsd: 0, profitRatio: 0, reason: 'Invalid research payload' };
    }

    const estimatedCostUsd = this.estimateLLMCost(payload.abstract, config);
    if (config.llmType === 'ollama') {
      return { shouldAccept: true, bountySyn, bountyUsd, estimatedCostUsd: 0, profitRatio: Infinity, reason: 'Local Ollama model: zero API cost, always accept' };
    }
    if (estimatedCostUsd === 0) {
      return { shouldAccept: true, bountySyn, bountyUsd, estimatedCostUsd: 0, profitRatio: Infinity, reason: 'Zero cost estimate, accepting' };
    }

    const profitRatio = bountyUsd / estimatedCostUsd;
    const shouldAccept = profitRatio >= config.minProfitRatio;
    return {
      shouldAccept, bountySyn, bountyUsd, estimatedCostUsd, profitRatio,
      reason: shouldAccept
        ? `Profitable: ratio ${profitRatio.toFixed(2)}x >= ${config.minProfitRatio}x minimum`
        : `Not profitable: ratio ${profitRatio.toFixed(2)}x < ${config.minProfitRatio}x minimum`,
    };
  }

  isResearchWorkOrder(workOrder: WorkOrder): boolean {
    if (workOrder.type === 'RESEARCH') return true;
    try {
      const payload = JSON.parse(workOrder.description);
      return !!(payload.title && payload.abstract);
    } catch { return false; }
  }

  extractResearchPayload(workOrder: WorkOrder): ResearchPayload | null {
    try {
      const payload = JSON.parse(workOrder.description);
      if (payload.title && payload.abstract) return { title: payload.title, abstract: payload.abstract };
      return null;
    } catch { return null; }
  }
}
