/**
 * Bug 31 (2026-05-18) — node-side submission quality gate tests.
 *
 * Mirrors coord's `submission-quality.spec.ts` so drift is caught at CI.
 * The local gate ONLY checks the low bar (>=30 chars, no placeholder,
 * no error markers) — the coord's stricter `passesQualityGate` decides
 * admission. The point of the local gate is to catch the 1-char-summary
 * class of failures observed live 2026-05-18 (value="{" on
 * wo_1779113721582_cb5db91b).
 */

import { describe, it, expect } from '@jest/globals';
import {
  validateResearchPayload,
  validateResearchResultJsonString,
  isNodeSidePlaceholder,
  COORD_HYPOTHESIS_MIN_CHARS,
} from '../node-side-submission-quality';

const GOOD_SUMMARY =
  'Riluzole at 50mg twice daily extends median ALS survival by approximately three months versus placebo across multiple replications.';

describe('node-side-submission-quality', () => {
  describe('isNodeSidePlaceholder', () => {
    it('flags angle-bracket placeholders', () => {
      expect(isNodeSidePlaceholder('<summary here>')).toBe(true);
      expect(isNodeSidePlaceholder('<3-4 sentences: problem, method, result>')).toBe(true);
    });
    it('flags legacy execute-research fallback strings', () => {
      expect(isNodeSidePlaceholder('No proposal generated')).toBe(true);
      expect(isNodeSidePlaceholder('No summary generated')).toBe(true);
      expect(isNodeSidePlaceholder('Analysis of ALS pathology')).toBe(true);
      expect(isNodeSidePlaceholder('Research completed')).toBe(true);
      expect(isNodeSidePlaceholder('[object Object]')).toBe(true);
    });
    it('does not flag real content', () => {
      expect(isNodeSidePlaceholder(GOOD_SUMMARY)).toBe(false);
      expect(isNodeSidePlaceholder('A novel mechanism for Aβ aggregation in late-onset Alzheimer.')).toBe(false);
    });
  });

  describe('validateResearchPayload', () => {
    it('admits a payload with >=30-char summary and no placeholders', () => {
      const res = validateResearchPayload({
        summary: GOOD_SUMMARY,
        proposal: 'Test the riluzole dosage in a new ALS cohort.',
        keyInsights: ['Median survival extension is ~3mo'],
      });
      expect(res.ok).toBe(true);
    });

    it('rejects the bare-`{` summary observed live (Bug 31 root cause)', () => {
      const res = validateResearchPayload({ summary: '{', keyInsights: [], proposal: '' });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('hypothesis_too_short');
      expect(res.detail).toContain('1 chars');
      expect(res.detail).toContain(`< ${COORD_HYPOTHESIS_MIN_CHARS} min`);
    });

    it('rejects empty payload', () => {
      const res = validateResearchPayload({ summary: '', proposal: '', keyInsights: [] });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('empty_payload');
    });

    it('rejects payloads with placeholder strings in any field', () => {
      const res = validateResearchPayload({
        summary: GOOD_SUMMARY,
        proposal: '<concrete application proposal>',
        keyInsights: [],
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('placeholder_or_error');
    });

    it('rejects payloads with Error: marker', () => {
      const res = validateResearchPayload({
        summary: 'Error: parser failed at offset 12',
        proposal: 'p',
        keyInsights: [],
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('placeholder_or_error');
    });

    it('rejects payloads with <!DOCTYPE marker (HTML scraped instead of JSON)', () => {
      const res = validateResearchPayload({
        summary: '<!DOCTYPE html><body>...',
        proposal: 'p',
        keyInsights: [],
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('placeholder_or_error');
    });

    it('accepts hypothesis alias for summary field', () => {
      const res = validateResearchPayload({
        hypothesis: GOOD_SUMMARY,
        proposal: 'test',
        keyInsights: [],
      });
      expect(res.ok).toBe(true);
    });

    // P26 reviewer-lesson — every interpolated user field must pass the
    // same validators. Both summary and proposal go through isPlaceholder.
    it('checks ALL user-input fields (P26 reviewer-lesson)', () => {
      const summary = validateResearchPayload({
        summary: 'No proposal generated', // placeholder in summary
        proposal: 'real proposal text here at least 30 chars long',
        keyInsights: [],
      });
      expect(summary.ok).toBe(false);
      const proposal = validateResearchPayload({
        summary: GOOD_SUMMARY,
        proposal: '<placeholder>',
        keyInsights: [],
      });
      expect(proposal.ok).toBe(false);
      const insight = validateResearchPayload({
        summary: GOOD_SUMMARY,
        proposal: 'real proposal text',
        keyInsights: ['real insight', 'Research completed'],
      });
      expect(insight.ok).toBe(false);
    });
  });

  describe('validateResearchResultJsonString', () => {
    it('rejects unparseable JSON', () => {
      const res = validateResearchResultJsonString('not json');
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('empty_payload');
    });

    it('rejects non-object JSON', () => {
      const res = validateResearchResultJsonString('"a string"');
      expect(res.ok).toBe(false);
    });

    it('admits a valid stringified payload', () => {
      const res = validateResearchResultJsonString(JSON.stringify({
        summary: GOOD_SUMMARY,
        proposal: 'A 12-week double-blind trial of riluzole 50mg BID in ALS patients.',
        keyInsights: ['Replicated 3-month survival extension'],
      }));
      expect(res.ok).toBe(true);
    });

    it('rejects the exact bare-`{` payload that hit coord 2026-05-18', () => {
      // The wire format the coord would see: result JSON has summary "{"
      // because parseResearchResult's old fallback sliced raw.slice(0,200).
      const wireBody = JSON.stringify({ summary: '{', keyInsights: [], proposal: '' });
      const res = validateResearchResultJsonString(wireBody);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('hypothesis_too_short');
    });
  });
});
