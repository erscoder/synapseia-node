/**
 * Tests for the medical self-critique prompt + parser (M3.3).
 *
 * Prompt-text assertions cover the ontologyGrounding dimension + harsh
 * grading rules. Parser tests cover the stricter pass rule (avg ≥ 7.0
 * AND grounding ≥ 6).
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

  it('documents the pass rule (avg ≥ 7.0 AND grounding ≥ 6)', () => {
    const p = buildMedicalSelfCritiquePrompt(base);
    expect(p).toMatch(/average.*≥\s*7\.0/i);
    expect(p).toMatch(/ontologyGrounding\s*is\s*≥\s*6/i);
  });
});

describe('parseMedicalSelfCritiqueResponse', () => {
  it('returns clamped scores + passed=true when all dimensions ≥ 7 and grounding ≥ 6', () => {
    const raw = JSON.stringify({
      accuracy: 8, completeness: 9, novelty: 7, actionability: 8, ontologyGrounding: 9,
      feedback: 'solid', passed: true,
    });
    const r = parseMedicalSelfCritiqueResponse(raw);
    expect(r.passed).toBe(true);
    expect(r.ontologyGrounding).toBe(9);
    expect(calculateMedicalAverageScore(r)).toBeCloseTo(8.2, 1);
  });

  it('fails when average is below 7.0 even if grounding is perfect', () => {
    const raw = JSON.stringify({
      accuracy: 4, completeness: 5, novelty: 5, actionability: 4, ontologyGrounding: 10,
      feedback: 'weak analysis', passed: true,
    });
    const r = parseMedicalSelfCritiqueResponse(raw);
    expect(r.passed).toBe(false);
  });

  it('fails when grounding < 6 even if the rest is perfect', () => {
    const raw = JSON.stringify({
      accuracy: 10, completeness: 10, novelty: 10, actionability: 10, ontologyGrounding: 3,
      feedback: 'invented DOIs', passed: true,
    });
    const r = parseMedicalSelfCritiqueResponse(raw);
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
