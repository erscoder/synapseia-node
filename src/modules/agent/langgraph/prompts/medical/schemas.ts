/**
 * Medical DiscoveryType schemas — node-side mirror of the coordinator's
 * `DiscoveryValidator` (packages/coordinator/src/application/research-rounds/
 * DiscoveryValidator.service.ts). Keep these in sync: the coordinator
 * silently drops structuredData that doesn't validate, so drift here means
 * the submission becomes a plain discovery with discoveryType = null.
 *
 * 2026-05-05 truthfulness fix (P10): the validator enforces two UNIVERSAL
 * fields on every discoveryType — `novel_contribution` (≥ 80 chars,
 * ≥ 15 distinct non-stopword tokens, must overlap with own structured
 * fields) and `evidence_type` (one of EVIDENCE_TYPES). Any LLM following
 * the prompt without these will fail validation after the 2-attempt
 * retry budget and the WO submission is dropped. Both are appended to
 * every per-type required[] so renderDiscoverySchemasForPrompt() advertises
 * them in every prompt that injects the schema block.
 */

export const DISCOVERY_TYPES = [
  'drug_repurposing',
  'combination_therapy',
  'biomarker',
  'mechanism_link',
  'procedure_refinement',
] as const;

export type DiscoveryType = (typeof DISCOVERY_TYPES)[number];

export interface DiscoverySchemaField {
  key: string;
  description: string;
}

export interface DiscoverySchema {
  type: DiscoveryType;
  when: string;
  required: DiscoverySchemaField[];
}

/**
 * Universal required fields enforced on every discoveryType by the
 * validator (see `validators/discovery-schema-validator.ts` →
 * requireNovelContribution / requireEvidenceType). Spread into each
 * schema's required[] so prompt rendering advertises them universally.
 */
const UNIVERSAL_REQUIRED: DiscoverySchemaField[] = [
  {
    key: 'novel_contribution',
    description:
      'plain-English claim of what is new. ≥ 80 chars and ≥ 15 distinct non-stopword tokens. Must reference at least one term from the structured fields above (drug name, disease, pathway, biomarker, etc.) so it is not generic boilerplate.',
  },
  {
    key: 'evidence_type',
    description:
      'one of literature_review | meta_analysis | gap_analysis | hypothesis_generation | contradiction_detected. meta_analysis requires ≥ 3 distinct supporting_dois; contradiction_detected requires novel_contribution to reference the conflict (contradict / disagree / conflict / inconsist / oppose).',
  },
];

export const DISCOVERY_SCHEMAS: DiscoverySchema[] = [
  {
    type: 'drug_repurposing',
    when: 'the paper suggests using an existing drug (with a known RxNorm ID) for a new disease indication.',
    required: [
      { key: 'drug_rxnorm_id', description: 'RxNorm RXCUI of the drug, e.g. "7933" for riluzole' },
      { key: 'disease_mesh_id', description: 'MeSH ID of the disease, e.g. "D000690" for ALS' },
      { key: 'mechanism_summary', description: 'plain-text 2-3 sentence mechanism of action for this indication. ≥ 50 chars.' },
      { key: 'supporting_dois', description: 'array of ≥ 2 DOI strings (format "10.xxxx/yyyy") drawn from the abstract or context' },
      ...UNIVERSAL_REQUIRED,
    ],
  },
  {
    type: 'combination_therapy',
    when: 'the paper proposes using two or more drugs together to produce a synergistic effect.',
    required: [
      { key: 'drugs_rxnorm_ids', description: 'array of ≥ 2 RxNorm RXCUIs of the drugs' },
      { key: 'disease_mesh_id', description: 'MeSH ID of the disease' },
      { key: 'synergy_evidence', description: 'plain-text rationale for why the combination is synergistic. ≥ 30 chars.' },
      { key: 'supporting_dois', description: 'array of ≥ 2 DOI strings' },
      ...UNIVERSAL_REQUIRED,
    ],
  },
  {
    type: 'biomarker',
    when: 'the paper identifies a measurable biological indicator of disease presence, progression, or therapy response.',
    required: [
      { key: 'biomarker_name', description: 'human-readable name of the biomarker (e.g. "neurofilament light chain")' },
      { key: 'umls_cui', description: 'UMLS CUI for the biomarker concept (e.g. "C1136396")' },
      { key: 'disease_mesh_id', description: 'MeSH ID of the disease' },
      { key: 'supporting_dois', description: 'array of ≥ 2 DOI strings' },
      ...UNIVERSAL_REQUIRED,
    ],
  },
  {
    type: 'mechanism_link',
    when: 'the paper connects a biological pathway or mechanism to one or more diseases.',
    required: [
      { key: 'pathway_name', description: 'name of the pathway, e.g. "TDP-43 proteinopathy" or "mitochondrial dysfunction"' },
      { key: 'disease_mesh_ids', description: 'array of ≥ 1 MeSH IDs of the linked diseases' },
      { key: 'mechanism_summary', description: 'plain-text mechanism explanation. ≥ 50 chars.' },
      { key: 'supporting_dois', description: 'array of ≥ 2 DOI strings' },
      ...UNIVERSAL_REQUIRED,
    ],
  },
  {
    type: 'procedure_refinement',
    when: 'the paper proposes a modification to an existing clinical or surgical procedure.',
    required: [
      { key: 'base_procedure_umls', description: 'UMLS CUI of the base procedure being refined' },
      { key: 'modification', description: 'plain-text description of the proposed modification. ≥ 30 chars.' },
      { key: 'disease_mesh_id', description: 'MeSH ID of the disease the procedure targets' },
      { key: 'supporting_dois', description: 'array of ≥ 2 DOI strings' },
      ...UNIVERSAL_REQUIRED,
    ],
  },
];

/** Build a human-readable block describing all 5 schemas for injection into prompts. */
export function renderDiscoverySchemasForPrompt(): string {
  return DISCOVERY_SCHEMAS.map((s) => {
    const fields = s.required.map((f) => `    - ${f.key}: ${f.description}`).join('\n');
    return `  • "${s.type}" — use when ${s.when}\n${fields}`;
  }).join('\n\n');
}
