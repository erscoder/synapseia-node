/**
 * Unit tests for PlanExecutionNode
 * Sprint B - Planning + Self-Critique
 */

import { jest } from '@jest/globals';
import { PlanExecutionNode, parseExecutionPlan, truncateMiddle, extractModelName } from '../nodes/plan-execution';
import type { AgentState, ExecutionStep } from '../state';
import { DEFAULT_EXECUTION_PLAN } from '../prompts/plan';

// Mock logger to avoid console output during tests AND let assertions
// observe warn() calls (Bug 6 — silent quality degradation surfaced as WARN).
// `jest.mock` is hoisted above imports, so the factory must construct the
// spies inline (no closing-over outer-scope vars). We then re-import the
// mocked module below and grab the spies for assertions.
jest.mock('../../../../utils/logger', () => {
  const m = {
    log: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return {
    __esModule: true,
    default: m,
    logger: m,
    log: m,
    warn: m.warn,
    error: m.error,
    debug: m.debug,
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const loggerMock = (require('../../../../utils/logger') as { default: { log: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock } }).default;

describe('PlanExecutionNode', () => {
  let node: PlanExecutionNode;
  let mockLlmService: { generate: ReturnType<typeof jest.fn>; generateJSON: ReturnType<typeof jest.fn> };
  let mockExecution: { extractResearchPayload: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    // Reset logger spies so each test sees its own calls in isolation.
    loggerMock.log.mockClear();
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    loggerMock.debug.mockClear();
    mockLlmService = {
      generate: jest.fn(),
      generateJSON: jest.fn(),
    };
    mockExecution = {
      extractResearchPayload: jest.fn((wo: any) => {
        // Mirror real behavior: try JSON first, then title fallback
        try {
          const parsed = JSON.parse(wo.description);
          if (parsed.title && parsed.abstract) return { title: parsed.title, abstract: parsed.abstract };
        } catch { /* ignore */ }
        return wo.title ? { title: wo.title, abstract: wo.abstract || '' } : null;
      }),
    };
    node = new PlanExecutionNode(mockLlmService as any, mockExecution as any);
  });

  function makeState(overrides: Partial<AgentState> = {}): AgentState {
    return {
      availableWorkOrders: [],
      selectedWorkOrder: null,
      economicEvaluation: null,
      executionResult: null,
      researchResult: null,
      qualityScore: 0,
      shouldSubmit: false,
      submitted: false,
      accepted: false,
      brain: { memory: [], goals: [], journal: [], strategy: { explorationRate: 0.5, focusArea: '', recentLessons: [], consecutiveFailures: 0 }, totalExperiments: 0, bestResult: null },
      iteration: 1,
      config: {
        coordinatorUrl: 'http://localhost:3701',
        peerId: 'peer1',
        capabilities: ['llm'],
        llmModel: { provider: 'ollama' as const, modelId: 'phi4-mini', providerId: '' },
        llmConfig: { timeoutMs: 30000 },
        intervalMs: 5000,
      },
      coordinatorUrl: 'http://localhost:3701',
      peerId: 'peer1',
      capabilities: ['llm'],
      // Sprint B fields
      relevantMemories: [],
      executionPlan: [],
      currentStepIndex: 0,
      selfCritiqueScore: 0,
      selfCritiquePassed: false,
      selfCritiqueFeedback: '',
      retryCount: 0,
      ...overrides,
    };
  }

  describe('for research work orders', () => {
    it('should return valid ExecutionStep[] from LLM response', async () => {
      const validPlan: ExecutionStep[] = [
        { id: '1', action: 'fetch_context', description: 'Search reference corpus' },
        { id: '2', action: 'analyze_paper', description: 'Extract key findings' },
        { id: '3', action: 'generate_hypothesis', description: 'Formulate hypothesis' },
      ];
      (mockLlmService.generateJSON as any).mockResolvedValueOnce(JSON.stringify(validPlan));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual(validPlan);
      expect(result.currentStepIndex).toBe(0);
    });

    it('should handle invalid JSON from LLM (fallback to default plan)', async () => {
      (mockLlmService.generateJSON as any).mockResolvedValueOnce('invalid json response');

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual(DEFAULT_EXECUTION_PLAN);
      expect(result.currentStepIndex).toBe(0);
    });

    it('should handle LLM error gracefully', async () => {
      (mockLlmService.generateJSON as any).mockRejectedValueOnce(new Error('LLM timeout'));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual(DEFAULT_EXECUTION_PLAN);
      expect(result.currentStepIndex).toBe(0);
    });

    it('should limit plan to 5 steps', async () => {
      const longPlan: ExecutionStep[] = Array.from({ length: 10 }, (_, i) => ({
        id: String(i + 1),
        action: 'fetch_context',
        description: `Step ${i + 1}`,
      }));
      (mockLlmService.generateJSON as any).mockResolvedValueOnce(JSON.stringify(longPlan));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toHaveLength(5);
    });

    it('should filter out invalid actions', async () => {
      const planWithInvalid = [
        { id: '1', action: 'fetch_context', description: 'Valid step' },
        { id: '2', action: 'invalid_action', description: 'Invalid action' },
        { id: '3', action: 'analyze_paper', description: 'Another valid step' },
      ];
      (mockLlmService.generateJSON as any).mockResolvedValueOnce(JSON.stringify(planWithInvalid));

      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Research', type: 'RESEARCH', abstract: 'Test abstract', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toHaveLength(2);
      expect(result.executionPlan?.[0].action).toBe('fetch_context');
      expect(result.executionPlan?.[1].action).toBe('analyze_paper');
    });

    it('should format memories for the prompt', async () => {
      (mockLlmService.generateJSON as any).mockResolvedValueOnce(JSON.stringify(DEFAULT_EXECUTION_PLAN));

      const state = makeState({
        selectedWorkOrder: { 
          id: 'wo-1', 
          title: 'Test Research', 
          type: 'RESEARCH', 
          description: JSON.stringify({ title: 'Test Research', abstract: 'Test abstract' }),
          reward: 100 
        } as any,
        relevantMemories: [
          { timestamp: 1, type: 'discovery', content: 'Memory 1', importance: 0.8 },
          { timestamp: 2, type: 'discovery', content: 'Memory 2', importance: 0.9 },
        ],
      });

      await node.execute(state);

      const prompt = (mockLlmService.generateJSON as any).mock.calls[0][1];
      expect(prompt).toContain('Memory 1');
      expect(prompt).toContain('Memory 2');
      expect(prompt).toContain('Test Research');
      expect(prompt).toContain('Test abstract');
    });

    it('should handle empty memories', async () => {
      (mockLlmService.generateJSON as any).mockResolvedValueOnce(JSON.stringify(DEFAULT_EXECUTION_PLAN));

      const state = makeState({
        selectedWorkOrder: { 
          id: 'wo-1', 
          title: 'Test Research', 
          type: 'RESEARCH', 
          description: JSON.stringify({ title: 'Test Research', abstract: 'Test abstract' }),
          reward: 100 
        } as any,
        relevantMemories: [],
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual(DEFAULT_EXECUTION_PLAN);
      const prompt = (mockLlmService.generateJSON as any).mock.calls[0][1];
      expect(prompt).toContain('None');
    });
  });

  describe('for non-research work orders (fast path)', () => {
    it('should skip planning for training WOs', async () => {
      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Training', type: 'TRAINING', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual([]);
      expect(result.currentStepIndex).toBe(0);
      expect(mockLlmService.generateJSON).not.toHaveBeenCalled();
    });

    it('should skip planning for inference WOs', async () => {
      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test Inference', type: 'CPU_INFERENCE', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual([]);
      expect(result.currentStepIndex).toBe(0);
      expect(mockLlmService.generateJSON).not.toHaveBeenCalled();
    });

    it('should skip planning for diloco WOs', async () => {
      const state = makeState({
        selectedWorkOrder: { id: 'wo-1', title: 'Test DiLoCo', type: 'DILOCO_TRAINING', abstract: '', reward: 100 } as any,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual([]);
      expect(result.currentStepIndex).toBe(0);
      expect(mockLlmService.generateJSON).not.toHaveBeenCalled();
    });
  });

  describe('when selected work order is null', () => {
    it('should return empty plan', async () => {
      const state = makeState({
        selectedWorkOrder: null,
      });

      const result = await node.execute(state);

      expect(result.executionPlan).toEqual([]);
      expect(result.currentStepIndex).toBe(0);
      expect(mockLlmService.generateJSON).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Bug 6 — parseExecutionPlan logs WARN (not INFO) with raw output preview
  // ──────────────────────────────────────────────────────────────────────

  describe('parseExecutionPlan (Bug 6 — silent quality degradation)', () => {
    function getWarnMessages(): string[] {
      return loggerMock.warn.mock.calls.map((c) => String(c[0]));
    }

    it('truncated JSON: warns at WARN level with raw output preview + model name', () => {
      const truncated = '[{"id":"1","action":"fetch_context","description":"open ended';
      const out = parseExecutionPlan(truncated, 'phi4-mini');
      expect(out).toEqual(DEFAULT_EXECUTION_PLAN);
      const msgs = getWarnMessages();
      // Plan-parse path emits exactly one warn; the outer execute() warn
      // is NOT reached because this is a direct method invocation.
      const parseFailMsgs = msgs.filter((m) => m.includes('LLM plan parse failed'));
      expect(parseFailMsgs).toHaveLength(1);
      expect(parseFailMsgs[0]).toContain('model=phi4-mini');
      expect(parseFailMsgs[0]).toContain(`output_len=${truncated.length}`);
      expect(parseFailMsgs[0]).toContain('falling back to default 3-step plan');
      // Raw output preview included verbatim (input is shorter than head+tail,
      // so the full string survives).
      expect(parseFailMsgs[0]).toContain('open ended');
    });

    it('leading prose before JSON: parseLlmJson recovers, no warn fired', () => {
      // parseLlmJson tolerates `Here is the plan: [...]` shape because the
      // structure extractor recovers `[...]`. So this is actually a HAPPY
      // path — assert NO warn fires + valid plan returned.
      const validPlan = [
        { id: '1', action: 'fetch_context', description: 'A' },
        { id: '2', action: 'analyze_paper', description: 'B' },
      ];
      const withProse = `Here is the plan:\n${JSON.stringify(validPlan)}\n\nThat's it.`;
      const out = parseExecutionPlan(withProse, 'gpt-4');
      expect(out).toEqual(validPlan);
      expect(loggerMock.warn).not.toHaveBeenCalled();
    });

    it('totally non-JSON: warns at WARN level (NOT info) with model name', () => {
      const garbage = 'sorry, I cannot help with that request.';
      const out = parseExecutionPlan(garbage, 'mini-max');
      expect(out).toEqual(DEFAULT_EXECUTION_PLAN);
      // Critical: warn fired, info NOT fired with the parse-fail message.
      const parseFailWarn = loggerMock.warn.mock.calls.find((c) =>
        String(c[0]).includes('LLM plan parse failed'),
      );
      expect(parseFailWarn).toBeDefined();
      expect(String(parseFailWarn?.[0])).toContain('model=mini-max');
      const parseFailInfo = loggerMock.info.mock.calls.find((c) =>
        String(c[0]).includes('Failed to parse plan'),
      );
      expect(parseFailInfo).toBeUndefined();
    });

    it('valid plan: no warn fires', () => {
      const validPlan = [
        { id: '1', action: 'fetch_context', description: 'A' },
        { id: '2', action: 'analyze_paper', description: 'B' },
        { id: '3', action: 'generate_hypothesis', description: 'C' },
      ];
      const out = parseExecutionPlan(JSON.stringify(validPlan), 'phi4');
      expect(out).toEqual(validPlan);
      expect(loggerMock.warn).not.toHaveBeenCalled();
    });

    it('empty array (all-invalid actions filtered): warns with structural-fail reason', () => {
      const allInvalid = JSON.stringify([
        { id: '1', action: 'bogus_action', description: 'X' },
      ]);
      const out = parseExecutionPlan(allInvalid, 'phi4');
      expect(out).toEqual(DEFAULT_EXECUTION_PLAN);
      const parseFailWarn = loggerMock.warn.mock.calls.find((c) =>
        String(c[0]).includes('LLM plan parse failed'),
      );
      expect(parseFailWarn).toBeDefined();
      expect(String(parseFailWarn?.[0])).toContain('No valid steps found');
    });

    it('long output: preview truncated to head 500 + tail 200 with " ... " separator', () => {
      // Build a long non-JSON string so the parser definitively fails and
      // the preview path triggers. 500 H chars + 800 mid + 200 T chars.
      const head = 'H'.repeat(500);
      const tail = 'T'.repeat(200);
      const mid = 'M'.repeat(800);
      const giant = `${head}${mid}${tail}`;
      parseExecutionPlan(giant, 'big-model');
      const parseFailWarn = loggerMock.warn.mock.calls.find((c) =>
        String(c[0]).includes('LLM plan parse failed'),
      );
      expect(parseFailWarn).toBeDefined();
      const msg = String(parseFailWarn?.[0]);
      // Preview contains the head and tail but NOT the middle stretch.
      expect(msg).toContain(head);
      expect(msg).toContain(tail);
      expect(msg).toContain(' ... ');
      // Middle Ms (800 of them, well over the elision boundary) absent.
      expect(msg.includes('M'.repeat(600))).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Bug 6 follow-up — model name coercion (no more `[object Object]`)
  // ──────────────────────────────────────────────────────────────────────

  describe('extractModelName helper', () => {
    it('returns string input verbatim', () => {
      expect(extractModelName('gemma3:12b')).toBe('gemma3:12b');
    });

    it('extracts modelId from LLMModel-shaped object with providerId prefix', () => {
      expect(
        extractModelName({ provider: 'cloud', providerId: 'openai', modelId: 'gpt-4o-mini' }),
      ).toBe('openai/gpt-4o-mini');
    });

    it('extracts modelId from LLMModel-shaped object without providerId, falls back to provider', () => {
      expect(
        extractModelName({ provider: 'ollama', providerId: '', modelId: 'phi4-mini' }),
      ).toBe('ollama/phi4-mini');
    });

    it('extracts `model` field from generic config object', () => {
      expect(extractModelName({ model: 'X' })).toBe('X');
    });

    it('extracts `name` field as final fallback', () => {
      expect(extractModelName({ name: 'Y' })).toBe('Y');
    });

    it('returns "unknown" for null / undefined', () => {
      expect(extractModelName(null)).toBe('unknown');
      expect(extractModelName(undefined)).toBe('unknown');
    });

    it('returns "unknown" for empty string', () => {
      expect(extractModelName('')).toBe('unknown');
    });

    it('falls back to String(value) for non-string primitives', () => {
      expect(extractModelName(42)).toBe('42');
      expect(extractModelName(true)).toBe('true');
    });

    it('falls back to String(value) for object without recognised fields', () => {
      // Plain `{}` stringifies to `[object Object]` — acceptable last resort.
      // The point of the helper is that LLMModel-shaped objects (the real
      // production caller) NEVER take this path.
      expect(extractModelName({ unrelated: 'field' })).toBe('[object Object]');
    });
  });

  describe('parseExecutionPlan with LLMModel object (Bug 6 follow-up regression guard)', () => {
    it('warn log contains real model name, not `[object Object]`, when passed an LLMModel object', () => {
      const llmModel = { provider: 'ollama', providerId: '', modelId: 'gemma3:12b' };
      parseExecutionPlan('not json at all', llmModel);
      const parseFailWarn = loggerMock.warn.mock.calls.find((c) =>
        String(c[0]).includes('LLM plan parse failed'),
      );
      expect(parseFailWarn).toBeDefined();
      const msg = String(parseFailWarn?.[0]);
      expect(msg).toContain('model=ollama/gemma3:12b');
      expect(msg).not.toContain('[object Object]');
    });

    it('warn log uses providerId prefix when present (cloud model)', () => {
      const llmModel = { provider: 'cloud', providerId: 'openai', modelId: 'gpt-4o-mini' };
      parseExecutionPlan('garbage', llmModel);
      const parseFailWarn = loggerMock.warn.mock.calls.find((c) =>
        String(c[0]).includes('LLM plan parse failed'),
      );
      expect(String(parseFailWarn?.[0])).toContain('model=openai/gpt-4o-mini');
    });
  });

  describe('truncateMiddle helper', () => {
    it('returns the input verbatim when shorter than head+tail', () => {
      expect(truncateMiddle('short', 500, 200)).toBe('short');
    });

    it('returns the input verbatim when exactly head+tail length', () => {
      const s = 'x'.repeat(700);
      expect(truncateMiddle(s, 500, 200)).toBe(s);
    });

    it('elides the middle with " ... " when longer', () => {
      const s = 'a'.repeat(500) + 'MIDDLE' + 'b'.repeat(200);
      const out = truncateMiddle(s, 500, 200);
      expect(out.startsWith('a'.repeat(500))).toBe(true);
      expect(out.endsWith('b'.repeat(200))).toBe(true);
      expect(out).toContain(' ... ');
      expect(out).not.toContain('MIDDLE');
    });

    it('empty string returns empty string (no elision)', () => {
      expect(truncateMiddle('', 500, 200)).toBe('');
    });
  });
});
