/**
 * Node-side discovery payload validator. Mirrors the coordinator's
 * `DiscoveryValidator.service.ts` (packages/coordinator/src/application/
 * research-rounds/DiscoveryValidator.service.ts) so the node can reject
 * malformed payloads BEFORE wasting an HTTP round-trip and before
 * hard-failing the submission-quality gate.
 *
 * Tier-3 audit follow-up 2026-04-26: previously the synthesizer LLM could
 * emit any garbage and the node would happily POST it; the coordinator
 * would then drop the structuredData silently. With telemetry in place
 * (extraction failure counters) we now also stop the bad payload at the
 * source: validate locally, loop the synthesizer with feedback up to 2
 * times, then fail the submission's quality score to 0.
 *
 * Pure function — no NestJS DI here so it stays portable into the
 * coordinator-client / shared layer if we ever extract it.
 *
 * IMPORTANT: keep in sync with the coordinator's validator. Any new
 * required field, evidence-type rule, or DOI normalization tweak must
 * land in BOTH files. The contract spec (discovery-schema-validator.spec.ts)
 * runs a representative payload through both implementations to catch drift.
 */

const DOI_REGEX = /^10\.\d{3,}\/.+/;

/** Mirror of EvidenceType enum from coordinator/src/domain/entities/Discovery.ts. */
export const EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  'literature_review',
  'meta_analysis',
  'gap_analysis',
  'hypothesis_generation',
  'contradiction_detected',
]);

/** Stems that MUST appear in novel_contribution when evidence_type = contradiction_detected. */
const CONTRADICTION_STEMS: readonly string[] = [
  'contradict', 'disagree', 'conflict', 'inconsist', 'oppose',
];

const NOVEL_CONTRIBUTION_MIN_CHARS = 80;
const NOVEL_CONTRIBUTION_MIN_DISTINCT_TOKENS = 15;
const META_ANALYSIS_MIN_DISTINCT_DOIS = 3;

const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'or', 'but', 'of', 'a', 'an', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'as', 'from', 'that', 'this', 'these', 'those', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
  'did', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can',
  'not', 'no', 'so', 'if', 'then', 'than', 'it', 'its', 'they', 'them',
  'their', 'we', 'our', 'you', 'your', 'he', 'she', 'his', 'her',
]);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function normalizeDoi(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Validate a structured-discovery payload. Returns `{ valid, errors }`.
 * Never throws; caller decides what to do with the errors (loop the
 * synthesizer, drop the submission, etc).
 */
export function validateDiscoverySchema(
  discoveryType: string | null | undefined,
  structuredData: Record<string, unknown> | null | undefined,
): ValidationResult {
  const errors: string[] = [];

  if (!discoveryType) errors.push('discoveryType is required');
  if (!structuredData || typeof structuredData !== 'object') {
    errors.push('structuredData is required and must be an object');
  }
  if (errors.length > 0) return { valid: false, errors };

  const data = structuredData as Record<string, unknown>;
  let ownFieldKeys: string[] = [];

  switch (discoveryType) {
    case 'drug_repurposing':
      requireNonEmptyString(data, 'drug_rxnorm_id', errors);
      requireNonEmptyString(data, 'disease_mesh_id', errors);
      requireStringMinLen(data, 'mechanism_summary', 50, errors);
      requireDistinctDoiArray(data, 'supporting_dois', 2, errors);
      ownFieldKeys = ['drug_rxnorm_id', 'disease_mesh_id', 'mechanism_summary'];
      break;
    case 'combination_therapy':
      requireStringArrayMinLen(data, 'drugs_rxnorm_ids', 2, errors);
      requireNonEmptyString(data, 'disease_mesh_id', errors);
      requireStringMinLen(data, 'synergy_evidence', 30, errors);
      requireDistinctDoiArray(data, 'supporting_dois', 2, errors);
      ownFieldKeys = ['drugs_rxnorm_ids', 'disease_mesh_id', 'synergy_evidence'];
      break;
    case 'biomarker':
      requireNonEmptyString(data, 'biomarker_name', errors);
      requireNonEmptyString(data, 'umls_cui', errors);
      requireNonEmptyString(data, 'disease_mesh_id', errors);
      optionalNumberInRange(data, 'sensitivity', 0, 1, errors);
      optionalNumberInRange(data, 'specificity', 0, 1, errors);
      requireDistinctDoiArray(data, 'supporting_dois', 2, errors);
      ownFieldKeys = ['biomarker_name', 'umls_cui', 'disease_mesh_id'];
      break;
    case 'mechanism_link':
      requireNonEmptyString(data, 'pathway_name', errors);
      requireStringArrayMinLen(data, 'disease_mesh_ids', 1, errors);
      requireStringMinLen(data, 'mechanism_summary', 50, errors);
      requireDistinctDoiArray(data, 'supporting_dois', 2, errors);
      ownFieldKeys = ['pathway_name', 'disease_mesh_ids', 'mechanism_summary'];
      break;
    case 'procedure_refinement':
      requireNonEmptyString(data, 'base_procedure_umls', errors);
      requireStringMinLen(data, 'modification', 30, errors);
      requireNonEmptyString(data, 'disease_mesh_id', errors);
      requireDistinctDoiArray(data, 'supporting_dois', 2, errors);
      ownFieldKeys = ['base_procedure_umls', 'modification', 'disease_mesh_id'];
      break;
    default:
      errors.push(`Unknown discoveryType: ${discoveryType}`);
      return { valid: false, errors };
  }

  requireNovelContribution(data, ownFieldKeys, errors);
  requireEvidenceType(data, errors);
  applyEvidenceTypeRules(data, errors);

  return { valid: errors.length === 0, errors };
}

/**
 * Pull the {discoveryType, structuredData} block out of an arbitrary
 * proposal string. Mirrors `DiscoveryService.extractStructuredPayload`
 * — same parse-first-then-detect-multi-object semantics.
 */
export function extractStructuredPayloadFromProposal(
  proposal: string,
):
  | { success: true; payload: { discoveryType: string; structuredData: Record<string, unknown> } }
  | { success: false; reason: string } {
  if (!proposal || proposal.length < 10) return { success: false, reason: 'no_proposal' };

  const jsonMatch = proposal.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { success: false, reason: 'no_json_block' };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    const firstObj = extractFirstBalancedObject(jsonMatch[0]);
    if (firstObj !== null) {
      const rest = jsonMatch[0].slice(firstObj.length).trimStart();
      if (rest.startsWith(',') && /^,\s*\{/.test(rest)) {
        return { success: false, reason: 'multi_object_paste' };
      }
    }
    return { success: false, reason: 'json_parse_error' };
  }

  const discoveryType = typeof parsed.discoveryType === 'string' ? parsed.discoveryType : null;
  if (!discoveryType) return { success: false, reason: 'missing_discovery_type' };

  const structuredData =
    parsed.structuredData &&
    typeof parsed.structuredData === 'object' &&
    !Array.isArray(parsed.structuredData)
      ? (parsed.structuredData as Record<string, unknown>)
      : null;
  if (!structuredData) return { success: false, reason: 'missing_structured_data' };

  return { success: true, payload: { discoveryType, structuredData } };
}

// ─── helpers (mirror coordinator's private methods) ──────────────────────────

function requireNonEmptyString(data: Record<string, unknown>, key: string, errors: string[]): void {
  const v = data[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    errors.push(`${key} must be a non-empty string`);
  }
}

function requireStringMinLen(
  data: Record<string, unknown>,
  key: string,
  min: number,
  errors: string[],
): void {
  const v = data[key];
  if (typeof v !== 'string') {
    errors.push(`${key} must be a string`);
    return;
  }
  if (v.trim().length < min) {
    errors.push(`${key} must be at least ${min} characters (got ${v.trim().length})`);
  }
}

function requireStringArrayMinLen(
  data: Record<string, unknown>,
  key: string,
  min: number,
  errors: string[],
): void {
  const v = data[key];
  if (!Array.isArray(v)) {
    errors.push(`${key} must be an array`);
    return;
  }
  const strs = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  if (strs.length < min) {
    errors.push(`${key} must contain ≥ ${min} non-empty strings (got ${strs.length})`);
  }
}

function requireDistinctDoiArray(
  data: Record<string, unknown>,
  key: string,
  min: number,
  errors: string[],
): void {
  const v = data[key];
  if (!Array.isArray(v)) {
    errors.push(`${key} must be an array`);
    return;
  }
  const valid = v.filter((x): x is string => typeof x === 'string' && DOI_REGEX.test(x));
  const distinct = new Set(valid.map((d) => normalizeDoi(d)));
  if (distinct.size < min) {
    errors.push(
      `${key} must contain ≥ ${min} distinct valid DOIs (got ${distinct.size} distinct from ${valid.length} raw)`,
    );
  }
}

function optionalNumberInRange(
  data: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  errors: string[],
): void {
  if (!(key in data)) return;
  const v = data[key];
  if (v === null || v === undefined) return;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push(`${key} must be a finite number if present`);
    return;
  }
  if (v < min || v > max) {
    errors.push(`${key} must be in [${min}, ${max}] (got ${v})`);
  }
}

function requireNovelContribution(
  data: Record<string, unknown>,
  ownFieldKeys: string[],
  errors: string[],
): void {
  const v = data['novel_contribution'];
  if (typeof v !== 'string' || v.trim().length === 0) {
    errors.push('novel_contribution must be a non-empty string');
    return;
  }
  if (v.trim().length < NOVEL_CONTRIBUTION_MIN_CHARS) {
    errors.push(
      `novel_contribution must be at least ${NOVEL_CONTRIBUTION_MIN_CHARS} characters (got ${v.trim().length})`,
    );
    return;
  }
  const tokens = tokenize(v);
  const distinct = new Set(tokens);
  if (distinct.size < NOVEL_CONTRIBUTION_MIN_DISTINCT_TOKENS) {
    errors.push(
      `novel_contribution must contain ≥ ${NOVEL_CONTRIBUTION_MIN_DISTINCT_TOKENS} distinct non-stopword tokens (got ${distinct.size})`,
    );
    return;
  }
  const ownText = ownFieldKeys
    .map((k) => data[k])
    .flatMap((val) => {
      if (typeof val === 'string') return [val];
      if (Array.isArray(val)) return val.filter((x): x is string => typeof x === 'string');
      return [];
    })
    .join(' ');
  const ownTokens = new Set(tokenize(ownText));
  const overlap = [...distinct].some((t) => ownTokens.has(t));
  if (!overlap) {
    errors.push(
      "novel_contribution must reference at least one term from the discovery's structured fields (looks generic)",
    );
  }
}

function requireEvidenceType(data: Record<string, unknown>, errors: string[]): void {
  const v = data['evidence_type'];
  if (typeof v !== 'string' || v.length === 0) {
    errors.push('evidence_type must be a non-empty string');
    return;
  }
  if (!EVIDENCE_TYPES.has(v)) {
    errors.push(
      `evidence_type must be one of ${[...EVIDENCE_TYPES].join(', ')} (got "${v}")`,
    );
  }
}

function applyEvidenceTypeRules(data: Record<string, unknown>, errors: string[]): void {
  const evidenceType = data['evidence_type'];
  if (typeof evidenceType !== 'string' || !EVIDENCE_TYPES.has(evidenceType)) return;

  if (evidenceType === 'meta_analysis') {
    const rawDois = data['supporting_dois'];
    if (Array.isArray(rawDois)) {
      const distinct = new Set(
        rawDois
          .filter((x): x is string => typeof x === 'string' && DOI_REGEX.test(x))
          .map((d) => normalizeDoi(d)),
      );
      if (distinct.size < META_ANALYSIS_MIN_DISTINCT_DOIS) {
        errors.push(
          `evidence_type=meta_analysis requires ≥ ${META_ANALYSIS_MIN_DISTINCT_DOIS} distinct supporting_dois (got ${distinct.size})`,
        );
      }
    }
  }

  if (evidenceType === 'contradiction_detected') {
    const contribution = data['novel_contribution'];
    if (typeof contribution === 'string') {
      const lower = contribution.toLowerCase();
      const matched = CONTRADICTION_STEMS.some((stem) => lower.includes(stem));
      if (!matched) {
        errors.push(
          `evidence_type=contradiction_detected requires novel_contribution to reference the conflict (one of ${CONTRADICTION_STEMS.join('|')})`,
        );
      }
    }
  }
}

function extractFirstBalancedObject(s: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  let startIdx = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && startIdx !== -1) return s.slice(startIdx, i + 1);
    }
  }
  return null;
}
