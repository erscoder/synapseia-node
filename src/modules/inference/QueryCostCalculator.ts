/**
 * Mirror of the coordinator-side `QueryCostCalculator`. The two copies MUST
 * produce identical prices for the same inputs — a parity test in both
 * packages validates this against a shared set of sample queries.
 *
 * Kept as a plain exported function (no DI) — the node runs on a light HTTP
 * server, not NestJS.
 */

const DEFAULT_MIN = 0.1;
const DEFAULT_MAX = 1.0;

const BIOMEDICAL_TERMS = [
  'als', 'amyotrophic', 'alzheimer', 'parkinson', 'huntington', 'ms', 'multiple sclerosis',
  'oncology', 'tumor', 'cancer', 'carcinoma', 'leukemia', 'lymphoma', 'glioma',
  'cardiovascular', 'hypertension', 'diabetes', 'autoimmune',
  'c9orf72', 'sod1', 'tardbp', 'fus', 'apoe', 'brca', 'tp53', 'kras',
  'mrna', 'rna', 'dna', 'protein', 'enzyme', 'receptor', 'mutation', 'gene',
  'genotype', 'phenotype', 'biomarker', 'pathway', 'mitochondri', 'microglia',
  'riluzole', 'edaravone', 'pembrolizumab', 'inhibitor', 'antagonist', 'agonist',
  'rna-seq', 'crispr', 'immunotherapy', 'chemotherapy', 'randomized',
  'placebo', 'double-blind', 'meta-analysis', 'systematic review',
  'clinical trial', 'phase ii', 'phase iii', 'in vitro', 'in vivo',
  'mesh', 'rxnorm', 'hgnc', 'umls', 'doi', 'pubmed',
];

export interface QueryCostCalculatorConfig {
  minPriceUsd: number;
  maxPriceUsd: number;
}

export function computeQueryPriceUsd(query: string, config: QueryCostCalculatorConfig): number {
  const min = Number.isFinite(config.minPriceUsd) ? config.minPriceUsd : DEFAULT_MIN;
  const max = Number.isFinite(config.maxPriceUsd) ? config.maxPriceUsd : DEFAULT_MAX;
  if (max <= min) return min;

  const text = (query ?? '').trim();
  if (text.length === 0) return min;

  const lower = text.toLowerCase();

  const words = text.split(/\s+/).filter(Boolean).length;
  const lengthScore = Math.min(words / 20, 1);

  let techTerms = 0;
  for (const term of BIOMEDICAL_TERMS) {
    if (lower.includes(term)) techTerms++;
  }
  const techScore = Math.min(techTerms / 5, 1);

  const hasCodeBlock = /```|\bcode\b|\bscript\b|\bsql\b|\bjson\b/.test(lower) ? 0.3 : 0;
  const hasCitation = /\bcit(e|ation)\b|\breference(s)?\b|\bsource(s)?\b|\bdoi\b/.test(lower)
    ? 0.3
    : 0;

  const raw = lengthScore + techScore + hasCodeBlock + hasCitation;
  const complexity = Math.min(raw / 2.6, 1);

  return Number((min + (max - min) * complexity).toFixed(6));
}

export function priceUsdFromEnv(query: string): number {
  const minPriceUsd = parseFloat(process.env.QUERY_MIN_PRICE ?? String(DEFAULT_MIN));
  const maxPriceUsd = parseFloat(process.env.QUERY_MAX_PRICE ?? String(DEFAULT_MAX));
  return computeQueryPriceUsd(query, { minPriceUsd, maxPriceUsd });
}
