/**
 * SynthesizerNode — Tier-3 schema-retry behavior.
 *
 * Covers the new retry loop introduced 2026-04-26: the node validates
 * the synthesizer's payload locally and reissues the LLM call up to 3
 * times with the schema errors fed back as critic feedback. After the
 * cap, executionResult.success flips to false so SubmitResultNode
 * skips the POST instead of shipping garbage.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { SynthesizerNode } from '../nodes/synthesizer-node';

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    selectedWorkOrder: { id: 'wo-1', type: 'RESEARCH' },
    researcherOutput: JSON.stringify({
      summary:
        'Riluzole repurposing for ALS extends survival via glutamate antagonism',
      keyInsights: ['Sodium channel block', 'Excitotoxicity'],
      discoveryType: 'drug_repurposing',
      structuredData: {
        drug_rxnorm_id: '9325',
        disease_mesh_id: 'D000690',
        mechanism_summary:
          'Riluzole inhibits voltage-gated sodium channels and presynaptic glutamate release.',
        supporting_dois: ['10.1056/x', '10.1016/y'],
      },
    }),
    criticOutput: 'critique passes',
    researchPayload: { title: 'Riluzole and ALS', abstract: 'X' },
    config: { llmModel: { provider: 'ollama', modelId: 'qwen2.5-3b' } },
    ...overrides,
  } as any;
}

const VALID_PROPOSAL = `Riluzole at 50mg twice daily extends median survival in definite/probable ALS by approximately three months versus placebo across multiple replications, with consistent benefit in bulbar and limb-onset subgroups. {"discoveryType":"drug_repurposing","structuredData":{"drug_rxnorm_id":"9325","disease_mesh_id":"D000690","mechanism_summary":"Riluzole inhibits voltage-gated sodium channels and presynaptic glutamate release, reducing excitotoxic injury to motor neurons.","supporting_dois":["10.1056/NEJM199403033300901","10.1016/S0140-6736(96)91680-3"],"novel_contribution":"Riluzole at 50mg twice daily extends median survival by approximately three months versus placebo in a 155-patient double-blind trial of definite or probable ALS, with consistent benefit in bulbar and limb-onset subgroups.","evidence_type":"literature_review"}}`;

const INVALID_WRONG_KEYS_PROPOSAL = `Riluzole and ALS short prose. {"discoveryType":"drug_repurposing","structuredData":{"RxNorm":["R03945"],"MeSH":["Heart failure"]}}`;

describe('SynthesizerNode — schema retry loop', () => {
  it('passes through on the first attempt when payload is valid', async () => {
    const generateLLM = jest.fn().mockResolvedValue(JSON.stringify({
      summary:
        'Riluzole at 50mg twice daily extends median survival in ALS by approximately three months.',
      keyInsights: ['Sodium-channel block', 'Excitotoxicity reduction'],
      proposal: VALID_PROPOSAL,
    }));
    const node = new SynthesizerNode(
      { generateLLM } as any,
      { reportHyperparamExperiment: jest.fn() } as any,
    );

    const result = await node.execute(makeState());

    expect(generateLLM).toHaveBeenCalledTimes(1);
    expect(result.executionResult?.success).toBe(true);
  });

  it('retries up to 3 times then marks the execution as failed when payload stays invalid', async () => {
    const generateLLM = jest.fn().mockResolvedValue(JSON.stringify({
      summary: 'attempt summary',
      keyInsights: ['a', 'b'],
      proposal: INVALID_WRONG_KEYS_PROPOSAL,
    }));
    const node = new SynthesizerNode(
      { generateLLM } as any,
      { reportHyperparamExperiment: jest.fn() } as any,
    );

    const result = await node.execute(makeState());

    expect(generateLLM).toHaveBeenCalledTimes(3);
    expect(result.executionResult?.success).toBe(false);
    expect(result.executionResult?.result).toMatch(/schema_invalid_after_retries/);
  });

  it('succeeds on a later attempt when the LLM eventually emits a valid payload', async () => {
    const generateLLM = jest.fn()
      .mockResolvedValueOnce(JSON.stringify({
        summary: 'first try', keyInsights: [], proposal: INVALID_WRONG_KEYS_PROPOSAL,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        summary: 'second try',
        keyInsights: ['Sodium-channel block', 'Excitotoxicity'],
        proposal: VALID_PROPOSAL,
      }));
    const node = new SynthesizerNode(
      { generateLLM } as any,
      { reportHyperparamExperiment: jest.fn() } as any,
    );

    const result = await node.execute(makeState());

    expect(generateLLM).toHaveBeenCalledTimes(2);
    expect(result.executionResult?.success).toBe(true);
  });

  it('falls back when the LLM call throws on the first attempt', async () => {
    const generateLLM = jest.fn().mockRejectedValue(new Error('ollama down'));
    const node = new SynthesizerNode(
      { generateLLM } as any,
      { reportHyperparamExperiment: jest.fn() } as any,
    );

    const result = await node.execute(makeState());

    // Falls back without retrying — fallback path uses the researcher's JSON.
    expect(generateLLM).toHaveBeenCalledTimes(1);
    expect(result.researchResult).toBeDefined();
  });
});
