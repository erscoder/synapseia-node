/**
 * Bug 22 (2026-05-17) — WO type → cap mapping + local accept gate.
 *
 * The bug: Mac M-series node-kike heartbeat correctly stripped
 * `diloco_training` from advertised caps (memory floor), but the node
 * still accepted a `wo_diloco_*` WO because the accept path only
 * checked `BackpressureService.canAccept()` (slot count) — no cap
 * gate. Coord rubber-stamped (stake tier matched), node spun up
 * Qwen2.5-7B and headed for OOM.
 *
 * These tests cover the centralized helper that BOTH the fetch-time
 * filter (`fetch-work-orders.ts`) AND the accept-time guard
 * (`accept-wo.ts`) use, so a future WO type added without a cap
 * mapping fails-closed in both places (P2 fail-closed, P6 single
 * funnel).
 */

import { canLocallyAcceptWorkOrder, woTypeToCap } from '../wo-type-to-cap';
import type { WorkOrder } from '../work-order.types';

const baseWo = (
  overrides: Partial<WorkOrder> = {},
): Pick<WorkOrder, 'type' | 'requiredCapabilities'> => ({
  type: 'DILOCO_TRAINING',
  requiredCapabilities: ['diloco_training'],
  ...overrides,
});

describe('woTypeToCap', () => {
  it('maps every documented WO type to its primary cap', () => {
    // Encoded here to catch silent typos and unintentional renames.
    expect(woTypeToCap({ type: 'CPU_INFERENCE' })).toBe('cpu_inference');
    expect(woTypeToCap({ type: 'GPU_INFERENCE' })).toBe('gpu_inference');
    // RESEARCH uses OR-semantics (inference OR llm alias).
    expect(woTypeToCap({ type: 'RESEARCH' })).toEqual(['inference', 'llm']);
    expect(woTypeToCap({ type: 'TRAINING' })).toBe('cpu_training');
    expect(woTypeToCap({ type: 'DILOCO_TRAINING' })).toBe('diloco_training');
    expect(woTypeToCap({ type: 'LORA_TRAINING' })).toBe('lora_training');
    expect(woTypeToCap({ type: 'LORA_VALIDATION' })).toBe('lora_training');
    expect(woTypeToCap({ type: 'MOLECULAR_DOCKING' })).toBe('molecular_docking');
  });

  it('returns null for missing type (fail-closed)', () => {
    expect(woTypeToCap({ type: undefined })).toBeNull();
  });

  it('returns null for unmapped type strings (fail-closed)', () => {
    // Cast lets us simulate a coord that ships a new WO type before the
    // node has the mapping — must fail closed per P2.
    expect(
      woTypeToCap({ type: 'SOME_FUTURE_TYPE' as unknown as WorkOrder['type'] }),
    ).toBeNull();
  });
});

describe('canLocallyAcceptWorkOrder', () => {
  it('accepts when WO type cap is in current caps and required caps subset', () => {
    const result = canLocallyAcceptWorkOrder(baseWo(), [
      'cpu_inference',
      'diloco_training',
    ]);
    expect(result.ok).toBe(true);
  });

  it('rejects when primary cap is missing — the live Bug 22 scenario', () => {
    // node-kike heartbeat stripped diloco_training under memory pressure;
    // currentCaps reflects what coord knows about us right now.
    const stripped = [
      'cpu_training',
      'cpu_inference',
      'inference',
      'llm',
      'embedding',
      'gpu_training',
      'gpu_inference',
    ];
    const result = canLocallyAcceptWorkOrder(baseWo(), stripped);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('diloco_training');
      expect(result.reason).toContain('current caps');
    }
  });

  it('rejects when current caps is empty (heartbeat not primed yet)', () => {
    const result = canLocallyAcceptWorkOrder(baseWo(), []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/heartbeat|primed/i);
    }
  });

  it('rejects unknown WO type fail-closed even when caps are healthy', () => {
    const result = canLocallyAcceptWorkOrder(
      { type: undefined, requiredCapabilities: [] },
      ['cpu_inference', 'diloco_training', 'lora_training', 'gpu_inference'],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/unknown|fail-closed/i);
    }
  });

  it('rejects when a WO.requiredCapabilities entry is missing even if primary matches', () => {
    // Coord tightens requirements (e.g. adds `cuda` to a GPU WO) after
    // our heartbeat — we must catch this too, not just the primary cap.
    const wo = {
      type: 'GPU_INFERENCE' as const,
      requiredCapabilities: ['gpu_inference', 'cuda'],
    };
    const result = canLocallyAcceptWorkOrder(wo, ['gpu_inference']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('cuda');
    }
  });

  it('accepts LORA_VALIDATION when lora_training cap is present and validator opt-in is on', () => {
    const orig = process.env.LORA_VALIDATOR_ENABLED;
    process.env.LORA_VALIDATOR_ENABLED = 'true';
    try {
      const result = canLocallyAcceptWorkOrder(
        { type: 'LORA_VALIDATION', requiredCapabilities: ['lora_training'] },
        ['lora_training', 'cpu_inference'],
      );
      expect(result.ok).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.LORA_VALIDATOR_ENABLED;
      else process.env.LORA_VALIDATOR_ENABLED = orig;
    }
  });

  // MEDIUM-1 — RESEARCH accepts either `inference` (preferred) or `llm`
  // (alias). Cloud-LLM-only edge nodes that advertise `llm` but not
  // `inference` were falsely rejected by the single-cap mapping.
  describe('RESEARCH OR-semantics (MEDIUM-1)', () => {
    it('accepts RESEARCH when only `llm` cap is present (no inference)', () => {
      const result = canLocallyAcceptWorkOrder(
        { type: 'RESEARCH', requiredCapabilities: [] },
        ['llm', 'cpu_inference'],
      );
      expect(result.ok).toBe(true);
    });

    it('accepts RESEARCH when only `inference` cap is present (no llm)', () => {
      const result = canLocallyAcceptWorkOrder(
        { type: 'RESEARCH', requiredCapabilities: [] },
        ['inference', 'cpu_inference'],
      );
      expect(result.ok).toBe(true);
    });

    it('accepts RESEARCH when both `inference` and `llm` are present', () => {
      const result = canLocallyAcceptWorkOrder(
        { type: 'RESEARCH', requiredCapabilities: [] },
        ['inference', 'llm', 'cpu_inference'],
      );
      expect(result.ok).toBe(true);
    });

    it('rejects RESEARCH when neither `inference` nor `llm` is present', () => {
      // Cap-stripped node (e.g. Ollama unavailable): inference + llm both gone.
      const result = canLocallyAcceptWorkOrder(
        { type: 'RESEARCH', requiredCapabilities: [] },
        ['gpu_inference', 'cpu_inference', 'embedding'],
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('inference');
        expect(result.reason).toContain('llm');
        expect(result.reason).toMatch(/none in current caps/i);
      }
    });
  });

  // MEDIUM-2 — LORA_VALIDATION needs explicit operator opt-in via
  // LORA_VALIDATOR_ENABLED=true. Without it, executor refuses and the
  // /accept POST is a wasted round-trip.
  describe('LORA_VALIDATION opt-in env gate (MEDIUM-2)', () => {
    let origFlag: string | undefined;
    beforeEach(() => {
      origFlag = process.env.LORA_VALIDATOR_ENABLED;
    });
    afterEach(() => {
      if (origFlag === undefined) delete process.env.LORA_VALIDATOR_ENABLED;
      else process.env.LORA_VALIDATOR_ENABLED = origFlag;
    });

    it('accepts when caps match AND LORA_VALIDATOR_ENABLED=true', () => {
      process.env.LORA_VALIDATOR_ENABLED = 'true';
      const result = canLocallyAcceptWorkOrder(
        { type: 'LORA_VALIDATION', requiredCapabilities: ['lora_training'] },
        ['lora_training', 'cpu_inference'],
      );
      expect(result.ok).toBe(true);
    });

    it('rejects when caps match but LORA_VALIDATOR_ENABLED=false', () => {
      process.env.LORA_VALIDATOR_ENABLED = 'false';
      const result = canLocallyAcceptWorkOrder(
        { type: 'LORA_VALIDATION', requiredCapabilities: ['lora_training'] },
        ['lora_training', 'cpu_inference'],
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/LORA_VALIDATOR_ENABLED/i);
        expect(result.reason).toMatch(/opt-in/i);
      }
    });

    it('rejects when caps match but LORA_VALIDATOR_ENABLED is unset', () => {
      delete process.env.LORA_VALIDATOR_ENABLED;
      const result = canLocallyAcceptWorkOrder(
        { type: 'LORA_VALIDATION', requiredCapabilities: ['lora_training'] },
        ['lora_training', 'cpu_inference'],
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/LORA_VALIDATOR_ENABLED/i);
      }
    });

    it('rejects when LORA_VALIDATOR_ENABLED has any non-"true" value (e.g. "1")', () => {
      // Defense-in-depth: only the literal string 'true' enables the gate,
      // matching execute-lora-validation.ts behaviour. Operators copy-pasting
      // `LORA_VALIDATOR_ENABLED=1` from sloppy docs should NOT accidentally
      // opt in.
      process.env.LORA_VALIDATOR_ENABLED = '1';
      const result = canLocallyAcceptWorkOrder(
        { type: 'LORA_VALIDATION', requiredCapabilities: ['lora_training'] },
        ['lora_training', 'cpu_inference'],
      );
      expect(result.ok).toBe(false);
    });
  });
});
