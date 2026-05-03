/**
 * SynthesizerNode — third step in the multi-agent research pipeline.
 * Takes researcher + critic outputs and produces the final ResearchResult.
 */

import { Injectable } from '@nestjs/common';
import type { AgentState } from '../state';
import { LlmProviderHelper } from '../../../llm/llm-provider';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { parseLlmJson } from '../../../../shared/parse-llm-json';
import { buildMedicalSynthesizerPrompt } from '../prompts/medical/medical-synthesizer';
import {
  extractStructuredPayloadFromProposal,
  validateDiscoverySchema,
} from '../validators/discovery-schema-validator';
import logger from '../../../../utils/logger';

/**
 * Tier-3 audit follow-up 2026-04-26: max attempts the synthesizer gets to
 * produce a schema-valid payload before we give up. Each attempt is one
 * LLM call. The coordinator's DiscoveryValidator silently dropped
 * malformed payloads in the audit window — failing locally saves a
 * wasted POST + a wasted evaluator review on garbage.
 *
 * Step 3 (2026-04-30) — lowered from 3 → 2. The third retry rarely
 * recovers when the first two failed for the same root cause (small-model
 * comprehension limit, context overflow, etc.); the saved LLM call is
 * material on CPU-only nodes.
 */
const SCHEMA_VALIDATION_MAX_ATTEMPTS = 2;

/**
 * Step 3 (2026-04-30) — concrete worked examples for the most common
 * recurring schema failures. Sourced from `discovery-schema-validator.ts`
 * error messages observed in `node_telemetry_events`. Kept under ~600
 * chars so the retry feedback doesn't blow the prompt budget on small
 * models.
 */
const SCHEMA_RETRY_FIELD_EXAMPLES =
  'CONCRETE EXAMPLES of the three most common failures:\n' +
  '- novel_contribution: WRONG: "" or "This study explores ALS." CORRECT: ' +
  '"Riluzole at 50mg twice daily extends median ALS survival ~3 months versus placebo across replications, with consistent benefit in bulbar and limb-onset subgroups." (≥80 chars, references the discovery).\n' +
  '- evidence_type: WRONG: "" or "study" or "Trial". CORRECT: one of ' +
  '"randomized_trial" | "meta_analysis" | "literature_review" | "case_series" | "mechanism_study" | "contradiction_detected".\n' +
  '- supporting_dois: WRONG: ["10.x", "10.x"] (duplicates) or [] or fabricated. CORRECT: ' +
  '["10.1056/NEJM199403033300901","10.1016/S0140-6736(96)91680-3"] (≥2 distinct, real DOIs from the abstract or critique).';

@Injectable()
export class SynthesizerNode {
  constructor(
    private readonly llmProvider: LlmProviderHelper,
    private readonly coordinator: WorkOrderCoordinatorHelper,
  ) {}

  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const researchOutput = state.researcherOutput;
    const criticOutput = state.criticOutput;
    const payload = state.researchPayload;

    if (!researchOutput || !criticOutput || !payload) {
      const missing = [
        !researchOutput && 'researcherOutput',
        !criticOutput && 'criticOutput',
        !payload && 'researchPayload',
      ].filter(Boolean).join(', ');
      logger.warn(`[SynthesizerNode] Missing inputs (${missing}) — falling back to direct result`);
      return this.fallbackResult(state);
    }

    let critiqueWithSchemaFeedback = criticOutput;
    let final: ReturnType<typeof this.parseResearchResult> | null = null;
    let lastSchemaErrors: string[] = [];

    for (let attempt = 1; attempt <= SCHEMA_VALIDATION_MAX_ATTEMPTS; attempt++) {
      const prompt = buildMedicalSynthesizerPrompt({
        title: payload.title,
        researcherJson: researchOutput,
        criticFeedback: critiqueWithSchemaFeedback,
      });

      let output: string;
      try {
        output = await this.llmProvider.generateLLM(
          state.config?.llmModel ?? { provider: 'ollama', modelId: 'qwen2.5-3b' } as any,
          prompt,
          state.config?.llmConfig,
          { forceJson: true },
        );
      } catch (err) {
        // Generation failures (fetch timeouts, provider 5xx) are recoverable:
        // we fall through to fallbackResult() which builds a submissible
        // payload from the researcher output. Warn keeps the operator
        // signal but stops the dashboard from flagging routine LLM blips
        // as severity=error events.
        logger.warn('[SynthesizerNode] LLM call failed, using researcher fallback:', (err as Error).message);
        return this.fallbackResult(state);
      }

      final = this.parseResearchResult(output);

      // Step 3 (2026-04-30) — context-overflow / silent-LLM short-circuit.
      // When the LLM returns prose-only or empty content (summary AND
      // proposal AND keyInsights all empty), retrying the same poison
      // input wastes another LLM call. Bail to a controlled failure so
      // SubmitResultNode skips the POST instead of looping.
      const isPoisonOutput =
        !final.summary.trim() &&
        !final.proposal.trim() &&
        final.keyInsights.length === 0;
      if (isPoisonOutput) {
        logger.warn(
          `[SynthesizerNode] attempt ${attempt}/${SCHEMA_VALIDATION_MAX_ATTEMPTS}: ` +
          `LLM emitted no parseable content (likely context overflow or silent failure) — short-circuiting`,
        );
        return {
          researchResult: { summary: '', keyInsights: [], proposal: '' },
          executionResult: {
            success: false,
            result: 'context_overflow_or_silent_llm',
          },
          qualityScore: 0,
        };
      }

      // Schema check — extract the {discoveryType, structuredData} block
      // out of the proposal and validate against the same contract the
      // coordinator enforces. A pass on the first attempt is the happy path.
      const extraction = extractStructuredPayloadFromProposal(final.proposal);
      if (!extraction.success) {
        lastSchemaErrors = [`extraction failed: ${extraction.reason}`];
        if (attempt < SCHEMA_VALIDATION_MAX_ATTEMPTS) {
          // Intermediate retry — final outcome is still pending. The
          // `giving up after N attempts` log at line ~179 fires at warn
          // when the chain ultimately exhausts.
          logger.info(
            `[SynthesizerNode] attempt ${attempt}/${SCHEMA_VALIDATION_MAX_ATTEMPTS}: ${lastSchemaErrors[0]} — retrying with feedback`,
          );
          critiqueWithSchemaFeedback = `${criticOutput}\n\n[SCHEMA-RETRY] Previous attempt could not be parsed: ${extraction.reason}. Output exactly ONE JSON object {discoveryType, structuredData} embedded in the proposal prose, using the EXACT field names from the schema (drug_rxnorm_id, disease_mesh_id, umls_cui, supporting_dois — no capitalized variants).`;
          continue;
        }
        break;
      }

      const validation = validateDiscoverySchema(
        extraction.payload.discoveryType,
        extraction.payload.structuredData,
      );
      if (validation.valid) {
        // Success — drop through with `final` set.
        if (attempt > 1) {
          logger.log(`[SynthesizerNode] schema valid on attempt ${attempt}`);
        }
        break;
      }

      lastSchemaErrors = validation.errors;
      if (attempt < SCHEMA_VALIDATION_MAX_ATTEMPTS) {
        // Intermediate retry — see note above; final exhaust is logged at warn.
        logger.info(
          `[SynthesizerNode] attempt ${attempt}/${SCHEMA_VALIDATION_MAX_ATTEMPTS}: schema invalid (${validation.errors.length} errors) — retrying`,
        );
        // Step 3 (2026-04-30): enrich retry feedback with WRONG/CORRECT
        // examples for the three recurring failure fields. Generic "fix
        // every listed error" was not enough signal for small models to
        // self-correct — observed in node_telemetry_events as repeated
        // novel_contribution / evidence_type / supporting_dois failures.
        critiqueWithSchemaFeedback = `${criticOutput}\n\n[SCHEMA-RETRY] Previous attempt failed validation:\n${validation.errors.map((e) => `- ${e}`).join('\n')}\nFix every listed error. Use the EXACT schema field names — no aliases or capitalizations.\n\n${SCHEMA_RETRY_FIELD_EXAMPLES}`;
      }
    }

    if (!final) {
      return this.fallbackResult(state);
    }

    // After all attempts, re-check the final candidate. If the schema is
    // still invalid we mark the execution as failed so SubmitResultNode
    // skips the POST instead of shipping garbage to the coordinator.
    const finalExtraction = extractStructuredPayloadFromProposal(final.proposal);
    const finalValidation =
      finalExtraction.success
        ? validateDiscoverySchema(finalExtraction.payload.discoveryType, finalExtraction.payload.structuredData)
        : { valid: false, errors: lastSchemaErrors };

    try {
      logger.log(`[SynthesizerNode] Final result: ${final.summary.slice(0, 80)}...`);

      if (!finalValidation.valid) {
        logger.warn(
          `[SynthesizerNode] giving up after ${SCHEMA_VALIDATION_MAX_ATTEMPTS} attempts — payload still invalid: ${finalValidation.errors.slice(0, 3).join('; ')}`,
        );
        return {
          researchResult: {
            summary: final.summary,
            keyInsights: final.keyInsights,
            proposal: final.proposal,
          },
          executionResult: {
            success: false,
            result: `schema_invalid_after_retries: ${finalValidation.errors.slice(0, 3).join('; ')}`,
          },
          qualityScore: 0,
        };
      }

      // Report experiment to coordinator if hyperparams available
      if (state.coordinatorUrl && state.peerId && state.config) {
        const qualityScore = Math.min(10,
          (final.keyInsights.length >= 3 ? 3 : final.keyInsights.length) +
          (final.summary.length > 200 ? 3 : 1) +
          (final.proposal.length > 100 ? 3 : 1),
        );
        try {
          await this.coordinator.reportHyperparamExperiment(
            state.coordinatorUrl,
            state.peerId,
            { id: 'unknown', temperature: 0.7, promptTemplate: 'default', analysisDepth: 'deep' },
            qualityScore,
            0,
          );
        } catch { /* ignore */ }
      }

      const researchResult = {
        summary: final.summary,
        keyInsights: final.keyInsights,
        proposal: final.proposal,
      };
      return {
        researchResult,
        // Required by SubmitResultNode to proceed with submission
        executionResult: { success: true, result: JSON.stringify(researchResult) },
        qualityScore: 0,
      };
    } catch (err) {
      // Reached only if the post-validation block above (logger.log,
      // reportHyperparamExperiment) throws — neither of which calls the LLM.
      // Mislabelled as "LLM call failed" historically; rename + warn since
      // fallback still yields a submissible payload.
      logger.warn('[SynthesizerNode] post-validation step failed, using fallback:', (err as Error).message);
      return this.fallbackResult(state);
    }
  }

  /**
   * Fallback when the synthesizer LLM call fails.
   *
   * The researcher emits `{summary, keyInsights, discoveryType, structuredData}`
   * (no proposal — the proposal is built downstream). When the synthesizer
   * fails we still want a submissible result, so we synthesize a proposal
   * locally: plain-English prose + the JSON block from the researcher.
   * The coordinator's extractStructuredPayload regex `/\{[\s\S]*\}/` grabs
   * the JSON block, so the structured discovery is preserved.
   */
  private fallbackResult(state: AgentState): Partial<AgentState> {
    const parsed = this.parseResearchResult(state.researcherOutput || '');
    const summary = parsed.summary || 'No summary generated';
    const proposalFromResearcher =
      parsed.discoveryType && parsed.structuredData
        ? `Proposed discovery: ${parsed.discoveryType}. ${summary} ${JSON.stringify({ discoveryType: parsed.discoveryType, structuredData: parsed.structuredData })}`
        : parsed.proposal || 'No proposal generated';
    const researchResult = {
      summary,
      keyInsights: parsed.keyInsights,
      proposal: proposalFromResearcher,
    };
    return {
      researchResult,
      executionResult: { success: true, result: JSON.stringify(researchResult) },
      qualityScore: 0,
    };
  }

  private parseResearchResult(raw: string): {
    summary: string;
    keyInsights: string[];
    proposal: string;
    discoveryType?: string;
    structuredData?: Record<string, unknown>;
  } {
    const result = parseLlmJson<{
      summary?: unknown;
      keyInsights?: unknown;
      proposal?: unknown;
      discoveryType?: unknown;
      structuredData?: unknown;
    }>(raw);
    if (!result.ok || !result.value) {
      return { summary: raw.slice(0, 200), keyInsights: [], proposal: '' };
    }
    const p = result.value;
    return {
      summary: String(p.summary ?? ''),
      keyInsights: Array.isArray(p.keyInsights) ? p.keyInsights.map(String) : [],
      proposal: String(p.proposal ?? ''),
      discoveryType: typeof p.discoveryType === 'string' ? p.discoveryType : undefined,
      structuredData:
        p.structuredData && typeof p.structuredData === 'object'
          ? (p.structuredData as Record<string, unknown>)
          : undefined,
    };
  }
}
