import { describe, it, expect } from '@jest/globals';
import { extractFirstJsonObject } from '../execute-research';

describe('extractFirstJsonObject', () => {
  it('returns the input verbatim when it is already pure JSON', () => {
    const json = '{"thought":"a","action":"generate_answer","answer":"hello"}';
    expect(extractFirstJsonObject(json)).toBe(json);
  });

  it('strips trailing prose after a balanced object', () => {
    const raw =
      '{"thought":"a","action":"generate_answer","answer":"hi"} Note: this is the answer.';
    const out = extractFirstJsonObject(raw);
    expect(out).toBe('{"thought":"a","action":"generate_answer","answer":"hi"}');
    expect(() => JSON.parse(out!)).not.toThrow();
  });

  it('extracts only the first object when two are stacked', () => {
    const raw =
      '{"thought":"first","action":"generate_answer","answer":"a"}\n{"second":"object"}';
    const out = extractFirstJsonObject(raw);
    expect(out).toBe('{"thought":"first","action":"generate_answer","answer":"a"}');
  });

  it('honors string literals containing braces', () => {
    const raw = '{"thought":"contains { and } literal","action":"generate_answer","answer":"hi"}garbage';
    const out = extractFirstJsonObject(raw);
    expect(out).toBe('{"thought":"contains { and } literal","action":"generate_answer","answer":"hi"}');
    const parsed = JSON.parse(out!) as { thought: string };
    expect(parsed.thought).toBe('contains { and } literal');
  });

  it('honors escaped quotes inside string literals', () => {
    const raw = '{"thought":"escaped \\" quote","action":"generate_answer","answer":"x"} trailing';
    const out = extractFirstJsonObject(raw);
    expect(out).toBe('{"thought":"escaped \\" quote","action":"generate_answer","answer":"x"}');
  });

  it('returns null when no opening brace is present', () => {
    expect(extractFirstJsonObject('not json at all')).toBeNull();
  });

  it('returns null when braces are unbalanced (no closing match)', () => {
    expect(extractFirstJsonObject('{"unterminated":')).toBeNull();
  });

  it('skips leading prose and finds the first balanced object', () => {
    const raw = 'Here is the response: {"thought":"x","action":"generate_answer","answer":"y"} done';
    const out = extractFirstJsonObject(raw);
    expect(out).toBe('{"thought":"x","action":"generate_answer","answer":"y"}');
  });
});
