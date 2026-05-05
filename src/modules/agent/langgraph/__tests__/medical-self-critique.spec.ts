/**
 * Tests for the medical self-critique prompt + parser (M3.3).
 *
 * Prompt-text assertions cover the ontologyGrounding dimension + harsh
 * grading rules. Parser tests cover the tiered pass rule (2026-05-05):
 *   - default / ID-bearing context → avg ≥ 7.0 AND og ≥ 7
 *   - mechanism_link OR evidence_type ∈ {literature_review,
 *     gap_analysis, hypothesis_generation} → avg ≥ 7.0 AND og ≥ 5
 */

import { describe, it, expect } from '@jest/globals';
import {
  buildMedicalSelfCritiquePrompt,
  parseMedicalSelfCritiqueResponse,
  calculateMedicalAverageScore,
} from '../prompts/medical/medical-self-critique';

describe('buildMedicalSelfCritiquePrompt', () => {
  const base = {
    title: 'SOD1 ASO extends ALS survival',
    summary: 'We report a 22% survival benefit of intrathecal tofersen in SOD1-mutant mice.',
    keyInsights: 'SOD1 mRNA reduction; CSF NfL decline; dose-dependent efficacy',
    proposal: 'Expand to human phase 3. {"discoveryType":"drug_repurposing","structuredData":{…}}',
  };

  it('embeds all four input fields', () => {
    const p = buildMedicalSelfCritiquePrompt(base);
    expect(p).toContain(base.title);
    expect(p).toContain(base.summary);
    expect(p).toContain(base.keyInsights);
    expect(p).toContain(base.proposal);
  });

  it('includes the 5 scoring dimensions — adds ontologyGrounding', () => {
    const p = buildMedicalSelfCritiquePrompt(base);
    expect(p).toContain('accuracy');
    expect(p).toContain('completeness');
    expect(p).toContain('novelty');
    expect(p).toContain('actionability');
    expect(p).toContain('ontologyGrounding');
  });

  it('tells the model to grade grounding harshly and lists ID format rules', () => {
    const p = buildMedicalSelfCritiquePrompt(base);
    expect(p.toLowerCase()).toContain('grade harshly');
    expect(p).toContain('drug_rxnorm_id');
    expect(p).toContain('disease_mesh_id');
    expect(p).toContain('umls_cui');
    expect(p).toContain('supporting_dois');
  });

  it('requires DOI cross-check against grounding sources', () => {
    const p = buildMedicalSelfCritiquePrompt({
      ...base,
      groundingSources: 'Abstract: ... DOI: 10.1056/NEJMoa2204705',
    });
    expect(p).toContain('Grounding sources');
    expect(p).toContain('10.1056/NEJMoa2204705');
  });

  it('documents the tiered pass rule (strict avg ≥ 7.0 + og ≥ 7; relaxed avg ≥ 5.5 + og ≥ 5)', () => {
    const p = buildMedicalSelfCritiquePrompt(base);
    // Strict tier — ID-bearing types on direct evidence
    expect(p).toMatch(/average\s*≥\s*7\.0/i);
    expect(p).toMatch(/ontologyGrounding\s*≥\s*7/i);
    // Relaxed tier — mechanism_link / review-class evidence
    expect(p).toMatch(/average\s*≥\s*5\.5/i);
    expect(p).toMatch(/ontologyGrounding\s*≥\s*5/i);
    expect(p).toContain('mechanism_link');
    expect(p).toContain('literature_review');
    expect(p).toContain('gap_analysis');
    expect(p).toContain('hypothesis_generation');
  });

  it('forbids wrong schema keys (RxNorm, MeSH, UMLS CUI) explicitly', () => {
    const p = buildMedicalSelfCritiquePrompt(base);
    // Anti-pattern enumeration must list the capitalized variants the
    // audit caught in production.
    expect(p).toContain('"RxNorm"');
    expect(p).toContain('"MeSH"');
    expect(p).toContain('"UMLS CUI"');
    expect(p.toLowerCase()).toContain('schema field names');
  });

  it('flags multi-object paste as automatic fail', () => {
    const p = buildMedicalSelfCritiquePrompt(base);
    expect(p).toContain('Multiple JSON objects');
    expect(p).toContain('}}, {');
  });
});

describe('parseMedicalSelfCritiqueResponse', () => {
  it('returns clamped scores + passed=true when all dimensions ≥ 7 and grounding ≥ 7 (default/ID-bearing tier)', () => {
    const raw = JSON.stringify({
      accuracy: 8, completeness: 9, novelty: 7, actionability: 8, ontologyGrounding: 9,
      feedback: 'solid', passed: true,
    });
    const r = parseMedicalSelfCritiqueResponse(raw);
    expect(r.passed).toBe(true);
    expect(r.ontologyGrounding).toBe(9);
    expect(calculateMedicalAverageScore(r)).toBeCloseTo(8.2, 1);
  });

  it('fails when average is below 7.0 on the strict (default) tier even if grounding is perfect', () => {
    const raw = JSON.stringify({
      accuracy: 4, completeness: 5, novelty: 5, actionability: 4, ontologyGrounding: 10,
      feedback: 'weak analysis', passed: true,
    });
    const r = parseMedicalSelfCritiqueResponse(raw);
    expect(r.passed).toBe(false);
  });

  it('fails on default tier when grounding < 7 even if the rest is perfect', () => {
    const raw = JSON.stringify({
      accuracy: 10, completeness: 10, novelty: 10, actionability: 10, ontologyGrounding: 3,
      feedback: 'invented DOIs', passed: true,
    });
    const r = parseMedicalSelfCritiqueResponse(raw);
    expect(r.passed).toBe(false);
  });

  it('passes on default tier with grounding=7 (relaxed from old og ≥ 8 floor)', () => {
    // 2026-05-05: og floor dropped from 8 → 7 for the default tier because
    // upstream universal-field validator now catches wrong-schema-key
    // payloads that the 2026-04-26 raise was guarding against.
    const raw = JSON.stringify({
      accuracy: 8, completeness: 8, novelty: 7, actionability: 8, ontologyGrounding: 7,
      feedback: 'tight grounding', passed: true,
    });
    const r = parseMedicalSelfCritiqueResponse(raw);
    expect(r.passed).toBe(true);
  });

  it('passes mechanism_link with og=5 (relaxed tier — pathway-only, no drug ID required)', () => {
    const raw = JSON.stringify({
      accuracy: 8, completeness: 8, novelty: 8, actionability: 7, ontologyGrounding: 5,
      feedback: 'pathway grounded, no drug', passed: true,
    });
    const r = parseMedicalSelfCritiqueResponse(raw, { discoveryType: 'mechanism_link' });
    expect(r.passed).toBe(true);
  });

  it('passes literature_review evidence_type with og=5 (relaxed tier)', () => {
    const raw = JSON.stringify({
      accuracy: 8, completeness: 8, novelty: 7, actionability: 7, ontologyGrounding: 5,
      feedback: 'survey paper, IDs sparse', passed: true,
    });
    const r = parseMedicalSelfCritiqueResponse(raw, {
      discoveryType: 'drug_repurposing',
      evidenceType: 'literature_review',
    });
    expect(r.passed).toBe(true);
  });

  it('passes relaxed tier with avg=5.6 (below strict 7.0 but above relaxed 5.5)', () => {
    // 2026-05-05 Task C: relaxed tier drops avg floor from 7.0 → 5.5 so
    // legitimate review/gap-analysis work scoring "4 fine + 1 weak" can
    // still pass. (5+6+6+6+5)/5 = 5.6.
    const raw = JSON.stringify({
      accuracy: 5, completeness: 6, novelty: 6, actionability: 6, ontologyGrounding: 5,
      feedback: 'survey paper, ID-sparse but coherent', passed: true,
    });
    const r = parseMedicalSelfCritiqueResponse(raw, {
      discoveryType: 'drug_repurposing',
      evidenceType: 'gap_analysis',
    });
    expect(r.passed).toBe(true);
  });

  it('relaxed tier still rejects mediocre-across-the-board (avg=5.0)', () => {
    // Relaxed avg floor is 5.5, NOT 5.0 — exactly 5/10 across all dims is
    // mediocre output, not just ID-sparse. The relaxed tier is for "4
    // strong + 1 weak", not blanket-mid scores.
    const raw = JSON.stringify({
      accuracy: 5, completeness: 5, novelty: 5, actionability: 5, ontologyGrounding: 5,
      feedback: 'mediocre across the board', passed: true,
    });
    const r = parseMedicalSelfCritiqueResponse(raw, { discoveryType: 'mechanism_link' });
    expect(r.passed).toBe(false);
  });

  it('still fails relaxed tier when og < 5', () => {
    const raw = JSON.stringify({
      accuracy: 9, completeness: 9, novelty: 9, actionability: 9, ontologyGrounding: 4,
      feedback: 'no grounding at all', passed: true,
    });
    const r = parseMedicalSelfCritiqueResponse(raw, { discoveryType: 'mechanism_link' });
    expect(r.passed).toBe(false);
  });

  it('does NOT relax for ID-bearing discoveryType + non-review evidence', () => {
    // drug_repurposing + meta_analysis stays on the strict tier (og ≥ 7).
    const raw = JSON.stringify({
      accuracy: 9, completeness: 9, novelty: 9, actionability: 9, ontologyGrounding: 6,
      feedback: 'ID-bearing, og=6 not enough', passed: true,
    });
    const r = parseMedicalSelfCritiqueResponse(raw, {
      discoveryType: 'drug_repurposing',
      evidenceType: 'meta_analysis',
    });
    expect(r.passed).toBe(false);
  });

  it('returns fail shape on malformed JSON', () => {
    const r = parseMedicalSelfCritiqueResponse('not json');
    expect(r.passed).toBe(false);
    expect(r.ontologyGrounding).toBe(0);
  });

  it('returns fail shape when a score field is missing', () => {
    const raw = JSON.stringify({ accuracy: 8, completeness: 8, novelty: 7, actionability: 7, feedback: 'missing' });
    const r = parseMedicalSelfCritiqueResponse(raw);
    expect(r.passed).toBe(false);
    expect(r.feedback).toMatch(/ontologyGrounding/);
  });

  it('clamps out-of-range numbers to [0, 10]', () => {
    const raw = JSON.stringify({
      accuracy: -5, completeness: 15, novelty: 7, actionability: 7, ontologyGrounding: 7,
      feedback: 'weird', passed: false,
    });
    const r = parseMedicalSelfCritiqueResponse(raw);
    expect(r.accuracy).toBe(0);
    expect(r.completeness).toBe(10);
  });
});
