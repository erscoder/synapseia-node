/**
 * Contract test for the node-side discovery validator. Mirrors the
 * coordinator's DiscoveryValidator.service.ts; if the two drift, the
 * coordinator silently drops payloads the node thinks are valid (the
 * exact failure mode the audit caught).
 *
 * The mirror lives intentionally as a vendor copy so the coordinator
 * can stay NestJS-DI-typed while the node stays a pure tsup-bundled
 * binary. Keep this file in sync with the coordinator's spec when
 * either side evolves.
 */

import { describe, it, expect } from '@jest/globals';
import {
  validateDiscoverySchema,
  extractStructuredPayloadFromProposal,
  normalizeDoi,
  EVIDENCE_TYPES,
} from '../validators/discovery-schema-validator';

const VALID_DRUG_REPURPOSING = {
  drug_rxnorm_id: '9325',
  disease_mesh_id: 'D000690',
  mechanism_summary:
    'Riluzole inhibits voltage-gated sodium channels and presynaptic glutamate release, reducing excitotoxic injury to motor neurons.',
  supporting_dois: ['10.1056/NEJM199403033300901', '10.1016/S0140-6736(96)91680-3'],
  novel_contribution:
    'Riluzole at 50mg twice daily extends median survival by approximately 3 months vs placebo in a 155-patient double-blind trial of definite or probable ALS, with consistent benefit across bulbar and limb-onset subgroups.',
  evidence_type: 'literature_review',
};

describe('validateDiscoverySchema', () => {
  it('accepts a well-formed drug_repurposing payload', () => {
    const r = validateDiscoverySchema('drug_repurposing', VALID_DRUG_REPURPOSING);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects unknown discoveryType', () => {
    const r = validateDiscoverySchema('quantum_entanglement', VALID_DRUG_REPURPOSING);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/Unknown discoveryType/);
  });

  it('rejects null discoveryType', () => {
    const r = validateDiscoverySchema(null, VALID_DRUG_REPURPOSING);
    expect(r.valid).toBe(false);
  });

  it('rejects null structuredData', () => {
    const r = validateDiscoverySchema('drug_repurposing', null);
    expect(r.valid).toBe(false);
  });

  it('rejects drug_repurposing with capitalized RxNorm key (audit failure mode)', () => {
    // The 2026-04-26 audit caught the LLM emitting "RxNorm" instead of
    // drug_rxnorm_id. The validator must reject it.
    const r = validateDiscoverySchema('drug_repurposing', {
      ...VALID_DRUG_REPURPOSING,
      drug_rxnorm_id: undefined,
      RxNorm: ['9325'],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('drug_rxnorm_id'))).toBe(true);
  });

  it('rejects when supporting_dois has < 2 distinct entries', () => {
    const r = validateDiscoverySchema('drug_repurposing', {
      ...VALID_DRUG_REPURPOSING,
      supporting_dois: ['10.1056/x'],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('supporting_dois'))).toBe(true);
  });

  it('collapses URL-prefixed DOIs as duplicates', () => {
    const r = validateDiscoverySchema('drug_repurposing', {
      ...VALID_DRUG_REPURPOSING,
      supporting_dois: ['10.1056/x', 'https://doi.org/10.1056/X'],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('1 distinct'))).toBe(true);
  });

  it('rejects mechanism_summary shorter than 50 chars', () => {
    const r = validateDiscoverySchema('drug_repurposing', {
      ...VALID_DRUG_REPURPOSING,
      mechanism_summary: 'too short',
    });
    expect(r.valid).toBe(false);
  });

  it('rejects novel_contribution shorter than 80 chars', () => {
    const r = validateDiscoverySchema('drug_repurposing', {
      ...VALID_DRUG_REPURPOSING,
      novel_contribution: 'short',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('novel_contribution'))).toBe(true);
  });

  it('rejects novel_contribution that does not overlap with own structured fields', () => {
    const r = validateDiscoverySchema('drug_repurposing', {
      ...VALID_DRUG_REPURPOSING,
      novel_contribution:
        'Generic boilerplate text about randomness, weather patterns, geological strata, and unrelated tangents stretching beyond eighty characters comfortably.',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('looks generic'))).toBe(true);
  });

  it('rejects unknown evidence_type', () => {
    const r = validateDiscoverySchema('drug_repurposing', {
      ...VALID_DRUG_REPURPOSING,
      evidence_type: 'sci_fi_speculation',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('evidence_type'))).toBe(true);
  });

  it('accepts a valid biomarker payload', () => {
    const r = validateDiscoverySchema('biomarker', {
      biomarker_name: 'Neurofilament light chain',
      umls_cui: 'C1136396',
      disease_mesh_id: 'D000690',
      supporting_dois: ['10.1056/x', '10.1016/y'],
      novel_contribution:
        'Serum neurofilament light chain rises 6 months before clinical onset in pre-symptomatic SOD1 carriers, offering a window for early intervention in familial ALS.',
      evidence_type: 'literature_review',
    });
    expect(r.valid).toBe(true);
  });

  it('rejects mechanism_link without disease_mesh_ids array', () => {
    const r = validateDiscoverySchema('mechanism_link', {
      pathway_name: 'TDP-43 proteinopathy',
      mechanism_summary:
        'TDP-43 mislocalization to the cytoplasm sequesters nuclear RNA-binding proteins and disrupts splicing of motor-neuron transcripts.',
      supporting_dois: ['10.1056/x', '10.1016/y'],
      novel_contribution:
        'TDP-43 cytoplasmic mislocalization is the unifying mechanism connecting C9orf72-ALS, sporadic-ALS, and a subset of FTD pathology with shared splicing defects.',
      evidence_type: 'literature_review',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('disease_mesh_ids'))).toBe(true);
  });

  it('enforces meta_analysis ≥ 3 distinct supporting_dois', () => {
    const r = validateDiscoverySchema('drug_repurposing', {
      ...VALID_DRUG_REPURPOSING,
      evidence_type: 'meta_analysis',
      // only 2 — meets common gate but fails meta_analysis prior
      supporting_dois: ['10.1056/x', '10.1016/y'],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('meta_analysis'))).toBe(true);
  });

  it('enforces contradiction_detected mentions the conflict', () => {
    const r = validateDiscoverySchema('drug_repurposing', {
      ...VALID_DRUG_REPURPOSING,
      evidence_type: 'contradiction_detected',
      // novel_contribution lacks contradict/disagree/conflict/inconsist/oppose stems
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('contradiction'))).toBe(true);
  });
});

describe('extractStructuredPayloadFromProposal', () => {
  it('extracts payload from a prose-wrapped proposal', () => {
    const proposal = `This work suggests repurposing riluzole for ALS. {"discoveryType":"drug_repurposing","structuredData":{"x":1}}`;
    const r = extractStructuredPayloadFromProposal(proposal);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.payload.discoveryType).toBe('drug_repurposing');
    }
  });

  it('detects multi_object_paste (verbatim audit shape)', () => {
    const proposal =
      `{"discoveryType":"biomarker","structuredData":{"x":1}}, {"discoveryType":"combination_therapy","structuredData":{"y":2}}`;
    const r = extractStructuredPayloadFromProposal(proposal);
    expect(r).toEqual({ success: false, reason: 'multi_object_paste' });
  });

  it('does NOT false-positive on nested arrays of objects', () => {
    const proposal = JSON.stringify({
      discoveryType: 'biomarker',
      structuredData: {
        variants: [{ id: 'rs1' }, { id: 'rs2' }],
      },
    });
    const r = extractStructuredPayloadFromProposal(proposal);
    expect(r.success).toBe(true);
  });

  it('returns no_proposal for empty input', () => {
    expect(extractStructuredPayloadFromProposal('')).toEqual({ success: false, reason: 'no_proposal' });
  });

  it('returns no_json_block for prose with no braces', () => {
    expect(extractStructuredPayloadFromProposal('plain prose, no JSON anywhere here'))
      .toEqual({ success: false, reason: 'no_json_block' });
  });
});

describe('normalizeDoi', () => {
  it('strips the resolver URL prefix', () => {
    expect(normalizeDoi('https://doi.org/10.1056/X')).toBe('10.1056/x');
    expect(normalizeDoi('http://dx.doi.org/10.1056/X')).toBe('10.1056/x');
  });

  it('lowercases and trims', () => {
    expect(normalizeDoi('  10.1056/ABC  ')).toBe('10.1056/abc');
  });
});

describe('EVIDENCE_TYPES catalog parity with coordinator', () => {
  it('contains exactly the 5 enum members the coordinator declares', () => {
    expect([...EVIDENCE_TYPES].sort()).toEqual([
      'contradiction_detected',
      'gap_analysis',
      'hypothesis_generation',
      'literature_review',
      'meta_analysis',
    ]);
  });
});
