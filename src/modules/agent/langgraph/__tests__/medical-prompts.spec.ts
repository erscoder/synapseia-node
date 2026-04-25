/**
 * Regression harness for the medical prompt module.
 *
 * These tests don't call an LLM — they assert the PROMPT TEXT contains
 * the right contract cues (all 5 discoveryTypes, the supporting_dois
 * rule, the grounding requirement) so future prompt edits can't silently
 * drift away from what the coordinator's DiscoveryValidator enforces.
 */

import { describe, it, expect } from '@jest/globals';
import { DISCOVERY_TYPES, renderDiscoverySchemasForPrompt } from '../prompts/medical/schemas';
import { buildMedicalResearcherPrompt } from '../prompts/medical/medical-researcher';
import { buildMedicalSynthesizerPrompt } from '../prompts/medical/medical-synthesizer';
import { buildMedicalReActPrompt } from '../prompts/medical/medical-react';

describe('medical prompt schemas', () => {
  it('exports exactly the 5 coordinator-side DiscoveryType literals', () => {
    expect(DISCOVERY_TYPES).toEqual([
      'drug_repurposing',
      'combination_therapy',
      'biomarker',
      'mechanism_link',
      'procedure_refinement',
    ]);
  });

  it('renderDiscoverySchemasForPrompt includes every type + supporting_dois', () => {
    const block = renderDiscoverySchemasForPrompt();
    for (const t of DISCOVERY_TYPES) expect(block).toContain(`"${t}"`);
    // supporting_dois appears per-schema, at minimum once per type
    const count = (block.match(/supporting_dois/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(DISCOVERY_TYPES.length);
  });

  it('schema block names the discriminating IDs the coordinator expects', () => {
    const block = renderDiscoverySchemasForPrompt();
    expect(block).toContain('drug_rxnorm_id');
    expect(block).toContain('disease_mesh_id');
    expect(block).toContain('umls_cui');
    expect(block).toContain('mechanism_summary');
    expect(block).toContain('biomarker_name');
    expect(block).toContain('drugs_rxnorm_ids');
    expect(block).toContain('base_procedure_umls');
    expect(block).toContain('disease_mesh_ids');
  });
});

describe('buildMedicalResearcherPrompt', () => {
  const base = {
    title: 'SOD1 knockdown extends survival in ALS mice',
    abstract: 'We report that antisense oligonucleotide knockdown of SOD1 in mutant mice extended median survival by 22% with no off-target effects.',
  };

  it('embeds title, abstract, and the 5-schema block', () => {
    const p = buildMedicalResearcherPrompt(base);
    expect(p).toContain(base.title);
    expect(p).toContain(base.abstract);
    for (const t of DISCOVERY_TYPES) expect(p).toContain(`"${t}"`);
  });

  it('includes DOI + related DOIs when provided', () => {
    const p = buildMedicalResearcherPrompt({
      ...base,
      doi: '10.1038/s41586-022-12345-6',
      relatedDois: ['10.1016/j.neuron.2021.00001', '10.1002/ana.12345'],
    });
    expect(p).toContain('10.1038/s41586-022-12345-6');
    expect(p).toContain('10.1016/j.neuron.2021.00001');
    expect(p).toContain('10.1002/ana.12345');
  });

  it('instructs the LLM not to invent DOIs', () => {
    const p = buildMedicalResearcherPrompt(base);
    expect(p.toLowerCase()).toContain('never invent a doi');
  });

  it('omits optional DOI block when neither paperDoi nor relatedDois given', () => {
    const p = buildMedicalResearcherPrompt(base);
    expect(p).not.toContain('DOI of this paper:');
    expect(p).not.toContain('Related paper DOIs');
  });

  it('output contract mentions summary / keyInsights / discoveryType / structuredData', () => {
    const p = buildMedicalResearcherPrompt(base);
    expect(p).toContain('"summary"');
    expect(p).toContain('"keyInsights"');
    expect(p).toContain('"discoveryType"');
    expect(p).toContain('"structuredData"');
  });

  it('injects missionContext block when provided', () => {
    const p = buildMedicalResearcherPrompt({
      ...base,
      missionContext:
        'ACTIVE MISSIONS:\n  • ALS: cure\n    Find treatments for ALS\n    - [find_compound] Drug repurposing',
    });
    expect(p).toContain('ACTIVE MISSIONS');
    expect(p).toContain('ALS: cure');
    expect(p).toContain('foreground that connection in your summary');
  });

  it('omits missionContext block when empty / undefined', () => {
    const p1 = buildMedicalResearcherPrompt({ ...base, missionContext: '' });
    const p2 = buildMedicalResearcherPrompt(base);
    expect(p1).not.toContain('ACTIVE MISSIONS');
    expect(p2).not.toContain('ACTIVE MISSIONS');
  });
});

describe('buildMedicalSynthesizerPrompt', () => {
  const researcherJson = JSON.stringify({
    summary: 'SOD1 ASO reduces mutant protein and extends survival in ALS models.',
    keyInsights: ['ASO targets SOD1 mRNA', 'Intrathecal delivery is tolerated', 'Effect size is dose-dependent'],
    discoveryType: 'drug_repurposing',
    structuredData: {
      drug_rxnorm_id: '2283485',
      disease_mesh_id: 'D000690',
      mechanism_summary: 'Antisense oligo tofersen reduces SOD1 mRNA, lowering mutant protein in motor neurons.',
      supporting_dois: ['10.1056/NEJMoa2204705', '10.1016/S0140-6736(22)01272-7'],
    },
  });

  it('instructs the LLM to embed a JSON block in the proposal field', () => {
    const p = buildMedicalSynthesizerPrompt({
      title: 'tofersen phase 3',
      researcherJson,
      criticFeedback: 'looks solid',
    });
    expect(p).toContain('discoveryType');
    expect(p).toContain('structuredData');
    expect(p.toLowerCase()).toContain('never invent a doi');
    expect(p).toContain('"proposal"');
  });

  it('requires proposal to be prose followed by a JSON block (not pure JSON)', () => {
    const p = buildMedicalSynthesizerPrompt({
      title: 'x',
      researcherJson: '{}',
      criticFeedback: 'x',
    });
    expect(p).toContain('prose paragraph');
    expect(p).toMatch(/≥\s*100 chars/);
    expect(p).toMatch(/≥\s*12 words/);
  });
});

describe('buildMedicalReActPrompt', () => {
  const base = {
    wo: { title: 'TDP-43 aggregation in ALS', abstract: 'TDP-43 proteinopathy is the hallmark of sporadic ALS…' },
    plan: ['1. Read abstract', '2. Identify pathway'],
    availableTools: '- search_corpus: query the corpus by topic',
    observations: [] as Array<{ tool: string; result: string }>,
  };

  it('accumulates observations into the rendered prompt', () => {
    const p = buildMedicalReActPrompt({
      ...base,
      observations: [{ tool: 'search_corpus', result: 'found 3 related papers' }],
    });
    expect(p).toContain('[1] search_corpus: found 3 related papers');
  });

  it('tells the LLM to fall back to mechanism_link when nothing else can be grounded', () => {
    const p = buildMedicalReActPrompt(base);
    expect(p).toContain('mechanism_link');
    expect(p.toLowerCase()).toContain('never invent');
  });

  it('emits the same 5-schema block as the other prompts', () => {
    const p = buildMedicalReActPrompt(base);
    for (const t of DISCOVERY_TYPES) expect(p).toContain(`"${t}"`);
  });
});
