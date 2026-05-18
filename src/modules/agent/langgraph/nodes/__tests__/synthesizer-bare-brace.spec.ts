/**
 * Bug 31 (2026-05-18) — synthesizer must not produce summary="{".
 *
 * Live symptom: pod 213.192 submitted RESEARCH WO wo_1779113721582_cb5db91b
 * with value="{" (1 literal `{`). Coord rejected with
 * `[WOSubmit] reject reason=hypothesis_too_short detail=1 chars < 30 min`.
 *
 * Root cause: `parseResearchResult` (synthesizer-node.ts) fell back to
 * `summary: raw.slice(0, 200)` when parseLlmJson returned ok=false.
 * For raw="{" the slice = "{" — non-empty enough to bypass the
 * `isPoisonOutput` short-circuit which requires summary AND proposal
 * AND keyInsights all empty.
 *
 * Fix: return summary='' when parseLlmJson fails so isPoisonOutput
 * fires on the first attempt; SubmitResultNode hard-guard then skips.
 *
 * P23 reviewer-lesson — verifies parseLlmJson does NOT silently swallow
 * the bare-brace input; the helper's own `repairLlmJson` returns `{}`
 * for "{", which used to bubble through with a stale summary slice.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { SynthesizerNode } from '../synthesizer-node';
import logger from '../../../../../utils/logger';

describe('SynthesizerNode — bare-`{` payload (Bug 31)', () => {
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;
  let infoSpy: jest.SpiedFunction<typeof logger.info>;
  let logSpy: jest.SpiedFunction<typeof logger.log>;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('returns success=false when LLM emits a single `{` character', async () => {
    const llmProvider = {
      generateLLM: jest.fn<(...args: any[]) => Promise<string>>().mockResolvedValue('{'),
    } as any;
    const coordinator = { reportHyperparamExperiment: jest.fn() } as any;
    const node = new SynthesizerNode(llmProvider, coordinator);

    const state: any = {
      researcherOutput: '{"summary":"valid researcher","keyInsights":["i1"],"proposal":"p"}',
      criticOutput: 'critic feedback',
      researchPayload: { title: 'paper', abstract: '...' },
      config: {
        llmModel: { provider: 'ollama', modelId: 'llama3.1:8b' },
        llmConfig: {},
      },
      coordinatorUrl: '',
      peerId: '',
    };

    const out = await node.execute(state);
    expect(out.executionResult?.success).toBe(false);
    // result string is an opaque short reason, not the bare `{`.
    expect(out.executionResult?.result).not.toBe('{');
    expect(out.executionResult?.result).toMatch(/context_overflow_or_silent_llm|schema_invalid_after_retries/);
    // researchResult.summary must be empty, NOT "{"
    expect(out.researchResult?.summary).toBe('');
  });

  it('returns success=false when LLM throws AND researcher output is also unparseable bare `{`', async () => {
    // Synthesizer LLM call throws → fallbackResult path; researcher output
    // is also bare `{` → parseResearchResult returns empty fields → fallback
    // detects empty summary/proposal → emits success=false (new Bug 31 fix).
    const llmProvider = {
      generateLLM: jest.fn<(...args: any[]) => Promise<string>>().mockRejectedValue(new Error('network error')),
    } as any;
    const coordinator = {} as any;
    const node = new SynthesizerNode(llmProvider, coordinator);

    const state: any = {
      researcherOutput: '{',
      criticOutput: 'critic',
      researchPayload: { title: 'paper', abstract: '...' },
      config: {
        llmModel: { provider: 'ollama', modelId: 'llama3.1:8b' },
        llmConfig: {},
      },
    };

    const out = await node.execute(state);
    expect(out.executionResult?.success).toBe(false);
    expect(out.executionResult?.result).toBe('researcher_output_unparseable');
    expect(out.researchResult?.summary).toBe('');
  });
});

