import { describe, it, expect } from '@jest/globals';
import {
  extractFirstJsonStructure,
  parseLlmJson,
  jsonParseTailSnippet,
} from '../parse-llm-json';

describe('extractFirstJsonStructure', () => {
  it('returns the input verbatim when it is already pure JSON object', () => {
    const json = '{"a":1}';
    expect(extractFirstJsonStructure(json)).toBe(json);
  });

  it('returns the input verbatim when it is already pure JSON array', () => {
    const json = '[1,2,3]';
    expect(extractFirstJsonStructure(json)).toBe(json);
  });

  it('strips trailing prose after a balanced object', () => {
    const raw = '{"a":1} Note: extra prose follows.';
    expect(extractFirstJsonStructure(raw)).toBe('{"a":1}');
  });

  it('strips trailing prose after a balanced array', () => {
    const raw = '[{"step":1}] then some commentary';
    expect(extractFirstJsonStructure(raw)).toBe('[{"step":1}]');
  });

  it('extracts only the first object when two are stacked', () => {
    const raw = '{"first":1}\n{"second":2}';
    expect(extractFirstJsonStructure(raw)).toBe('{"first":1}');
  });

  it('honours string literals containing braces and brackets', () => {
    const raw = '{"thought":"contains { } and [ ] literals","x":1}garbage';
    const out = extractFirstJsonStructure(raw);
    expect(out).toBe('{"thought":"contains { } and [ ] literals","x":1}');
    expect(JSON.parse(out!)).toEqual({
      thought: 'contains { } and [ ] literals',
      x: 1,
    });
  });

  it('honours escaped quotes inside string literals', () => {
    const raw = '{"a":"escaped \\" quote","b":2} trailing';
    const out = extractFirstJsonStructure(raw);
    expect(out).toBe('{"a":"escaped \\" quote","b":2}');
  });

  it('skips leading prose and finds the first balanced object', () => {
    const raw = 'Here is the response: {"x":1} done';
    expect(extractFirstJsonStructure(raw)).toBe('{"x":1}');
  });

  it('picks the earliest opener — array before object', () => {
    const raw = 'prefix [1,2] then {"y":3}';
    expect(extractFirstJsonStructure(raw)).toBe('[1,2]');
  });

  it('picks the earliest opener — object before array', () => {
    const raw = 'prefix {"y":3} then [1,2]';
    expect(extractFirstJsonStructure(raw)).toBe('{"y":3}');
  });

  it('returns null when no opening delimiter is present', () => {
    expect(extractFirstJsonStructure('not json at all')).toBeNull();
  });

  it('returns null when braces are unbalanced (no closing match)', () => {
    expect(extractFirstJsonStructure('{"unterminated":')).toBeNull();
  });
});

describe('parseLlmJson', () => {
  it('parses a clean object', () => {
    const r = parseLlmJson<{ a: number }>('{"a":1}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1 });
    expect(r.recoveredFrom).toBe('envelope');
  });

  it('parses a clean array', () => {
    const r = parseLlmJson<number[]>('[1,2,3]');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual([1, 2, 3]);
  });

  it('strips <think>...</think> reasoning before parsing', () => {
    const r = parseLlmJson<{ a: number }>('<think>scratchpad</think>\n{"a":1}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1 });
  });

  it('recovers when LLM appends trailing prose to a JSON object', () => {
    const r = parseLlmJson<{ thought: string }>(
      '{"thought":"hello"} (note: this is the answer)',
    );
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ thought: 'hello' });
    expect(r.recoveredFrom).toBe('extraction');
  });

  it('recovers when LLM appends trailing prose to a JSON array', () => {
    const r = parseLlmJson<number[]>('[1,2,3]\nDone.');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual([1, 2, 3]);
    expect(r.recoveredFrom).toBe('extraction');
  });

  it('recovers when output is wrapped in a markdown fence', () => {
    const r = parseLlmJson<{ x: number }>('```json\n{"x":42}\n```');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ x: 42 });
  });

  it('recovers when there are two stacked objects (returns the first)', () => {
    const r = parseLlmJson<{ first: number }>('{"first":1}\n{"second":2}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ first: 1 });
  });

  it('returns ok=false for empty input', () => {
    const r = parseLlmJson<unknown>('');
    expect(r.ok).toBe(false);
    expect(r.value).toBeNull();
  });

  it('returns ok=false for whitespace-only input', () => {
    const r = parseLlmJson<unknown>('   \n  ');
    expect(r.ok).toBe(false);
  });

  it('returns ok=false when no JSON structure exists', () => {
    const r = parseLlmJson<unknown>('this is plain prose');
    expect(r.ok).toBe(false);
    expect(r.value).toBeNull();
  });

  it('returns ok=false for malformed JSON that has no balanced structure', () => {
    const r = parseLlmJson<unknown>('{ "missing": ');
    expect(r.ok).toBe(false);
    expect(r.value).toBeNull();
    expect(r.error).toBeDefined();
  });

  it('handles null and undefined gracefully', () => {
    expect(parseLlmJson<unknown>(null).ok).toBe(false);
    expect(parseLlmJson<unknown>(undefined).ok).toBe(false);
  });
});

describe('jsonParseTailSnippet', () => {
  it('returns 80 chars from the position reported in the error', () => {
    const cleaned = '{"a":1} this is the trailing garbage that should appear in the snippet';
    const errorMsg = 'Unexpected non-whitespace character after JSON at position 7';
    const tail = jsonParseTailSnippet(cleaned, errorMsg);
    expect(tail.startsWith(' this')).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(80);
  });

  it('returns empty string when error message lacks position', () => {
    expect(jsonParseTailSnippet('foo bar', 'unexpected token')).toBe('');
  });

  it('returns empty string when error message is undefined', () => {
    expect(jsonParseTailSnippet('foo', undefined)).toBe('');
  });

  it('collapses whitespace inside the snippet to single spaces', () => {
    const cleaned = '{"a":1}\n\n\n   newline   garbage';
    const tail = jsonParseTailSnippet(
      cleaned,
      'Unexpected non-whitespace character after JSON at position 7',
    );
    expect(tail).not.toMatch(/\n/);
    expect(tail).not.toMatch(/ {2,}/);
  });
});
